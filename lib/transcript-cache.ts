import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { dependencyUnavailable } from '@/lib/dependency-unavailable';
import { supadataNativeCacheIdentity } from '@/lib/supadata-transcript-provider';
import { extractVideoId } from '@/lib/utils';
import { AbortManager, awaitWithSignal } from '@/lib/promise-utils';

const ownerContext = new AsyncLocalStorage<{ key: string; owner: string; signal: AbortSignal; possiblyDispatched: boolean }>();
const FOLLOWER_WAIT_MS = 25_000;
const LEADER_WORK_MS = 45_000; // Leaves 15s of the database lease for publication/transport.
type CachedTranscript = {
  transcript: { text: string; start: number; duration: number }[];
  transcriptDuration: number;
  isPartial: false;
  language?: string;
  availableLanguages?: string[];
};
type State = { state: 'hit'; payload: CachedTranscript } |
  { state: 'leader'; owner: string } | { state: 'waiting'; retry_at: string } | { state: 'miss' };

async function rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const manager = new AbortManager();
  const timeout = manager.createController('rpc', 5000);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    combined.throwIfAborted();
    const { data, error } = await awaitWithSignal(createServiceRoleClient().rpc(name, args).abortSignal(combined), combined);
    if (error) throw error;
    return data;
  } catch (error) { throw dependencyUnavailable('transcript-cache', error); }
  finally { manager.cleanup(); }
}

function state(value: unknown): State {
  const result = value as State | null;
  if (result?.state === 'miss' || (result?.state === 'leader' && typeof result.owner === 'string' &&
    /^[0-9a-f-]{36}$/i.test(result.owner)) || (result?.state === 'waiting' &&
    typeof result.retry_at === 'string' && Number.isFinite(Date.parse(result.retry_at)))) return result;
  if (result?.state === 'hit' && result.payload && Array.isArray(result.payload.transcript) &&
    result.payload.transcript.length > 0 && result.payload.isPartial === false &&
    typeof result.payload.transcriptDuration === 'number' && Number.isFinite(result.payload.transcriptDuration) &&
    result.payload.transcriptDuration >= 0 && result.payload.transcript.every(segment => segment &&
      typeof segment.text === 'string' && segment.text.trim().length > 0 &&
      Number.isFinite(segment.start) && segment.start >= 0 && Number.isFinite(segment.duration) && segment.duration >= 0) &&
    (result.payload.language === undefined || typeof result.payload.language === 'string') &&
    (result.payload.availableLanguages === undefined || (Array.isArray(result.payload.availableLanguages) &&
      result.payload.availableLanguages.every(language => typeof language === 'string')))) return result;
  throw dependencyUnavailable('transcript-cache-response');
}

/** Fence a slow leader immediately before it can authorize paid dispatch. */
export async function assertTranscriptCacheOwner(possibleDispatch = false): Promise<void> {
  const owner = ownerContext.getStore();
  if (!owner || await rpc('transcript_cache_assert_owner', { p_key: owner.key, p_owner: owner.owner }, owner.signal) !== true) {
    throw dependencyUnavailable('transcript-cache-lease');
  }
  owner.signal.throwIfAborted();
  if (possibleDispatch) owner.possiblyDispatched = true;
}

function hit(payload: CachedTranscript, expectedDuration?: number): NextResponse {
  // Do not replay another visitor's request correlation identifier.
  const requestId = crypto.randomUUID();
  const duration = payload.transcriptDuration;
  return NextResponse.json({ ...payload, requestId, transcriptCache: 'hit',
    isPartial: expectedDuration ? duration < expectedDuration * 0.5 : false,
    coverageRatio: expectedDuration ? Math.round(duration / expectedDuration * 100) : undefined,
  }, {
    headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId },
  });
}

/** Called after server eligibility, before claiming a fresh initial operation. */
export async function reuseTranscript(request: NextRequest, fresh: (signal?: AbortSignal) => Promise<NextResponse>): Promise<NextResponse> {
  const { url, lang, refresh, expectedDuration } = await request.clone().json();
  const video = typeof url === 'string' ? extractVideoId(url) : null;
  if (!video || (lang !== undefined && (typeof lang !== 'string' ||
    !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(lang))) ||
    (refresh !== undefined && typeof refresh !== 'boolean') || (expectedDuration !== undefined &&
      (typeof expectedDuration !== 'number' || !Number.isFinite(expectedDuration) || expectedDuration <= 0))) {
    return NextResponse.json({ error: 'Invalid transcript request' }, { status: 400 });
  }
  request.signal.throwIfAborted();
  const key = supadataNativeCacheIdentity(video, lang?.toLowerCase());
  let result = state(await rpc('transcript_cache_acquire', { p_key: key, p_refresh: refresh === true }, request.signal));
  if (result.state === 'hit') return hit(result.payload, expectedDuration);
  if (result.state === 'leader') {
    const owner = result.owner;
    const manager = new AbortManager();
    const timeout = manager.createController('leader', LEADER_WORK_MS);
    const signal = AbortSignal.any([request.signal, timeout.signal]);
    const context = { key, owner, signal, possiblyDispatched: false };
    let response: NextResponse;
    try {
      signal.throwIfAborted();
      response = await awaitWithSignal(ownerContext.run(context, () => fresh(signal)), signal);
    } catch (error) {
      // A lost response/transition may follow vendor acceptance. Never release into an immediate retry.
      await rpc('transcript_cache_finish', { p_key: key, p_owner: owner, p_payload: null, p_uncertain: context.possiblyDispatched });
      throw dependencyUnavailable('transcript-acquisition', error);
    } finally { manager.cleanup(); }
    const payload = await awaitWithSignal(response.clone().json(), AbortSignal.timeout(5000));
    const reusable = response.ok && payload.outcome === 'success' && payload.isPartial === false;
    const uncertain = payload.outcome === 'unknown_upstream_acceptance' || (response.status >= 500 && context.possiblyDispatched);
    // Correlation/coverage belong to the request, not the shared caption record.
    const stored = { ...payload };
    delete stored.requestId;
    delete stored.coverageRatio;
    if (reusable) state({ state: 'hit', payload: stored });
    // Persist before responding, independently of subsequent highlights or customer-credit writes.
    if (await rpc('transcript_cache_finish', { p_key: key, p_owner: owner,
      p_payload: reusable ? stored : null, p_uncertain: uncertain }) !== true) {
      throw dependencyUnavailable('transcript-cache-publication');
    }
    return response;
  }
  const deadline = Date.now() + FOLLOWER_WAIT_MS;
  const manager = new AbortManager();
  const timeout = manager.createController('follower', FOLLOWER_WAIT_MS);
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  // Followers never elect or dispatch, even if the leader disappears while they wait.
  try {
    while (result.state === 'waiting' && Date.now() < deadline) {
      await delay(Math.min(250, deadline - Date.now()), undefined, { signal });
      result = state(await rpc('transcript_cache_read', { p_key: key }, signal));
      if (result.state === 'hit') return hit(result.payload, expectedDuration);
    }
  } catch (error) {
    if (!timeout.signal.aborted || request.signal.aborted) throw dependencyUnavailable('transcript-cache-wait', error);
  } finally { manager.cleanup(); }
  const resetAt = result.state === 'waiting' ? result.retry_at : new Date(Date.now() + 1000).toISOString();
  const retryAfter = Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000));
  return NextResponse.json({ code: 'TRANSCRIPT_SPEND_THROTTLED', reason: 'cooldown',
    error: 'A shared transcript request is pending. Please wait before explicitly retrying.', resetAt, retryAfter,
  }, { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(retryAfter) } });
}
