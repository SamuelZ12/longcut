import 'server-only';
import { AbortManager } from '@/lib/promise-utils';

export const VAKITEK_TIMEOUT_MS = 20_000;

type VakitekFailure =
  | { outcome: 'unavailable'; reason: 'no_captions' | 'language_not_available' | 'not_found' | 'private' | 'members_only' | 'age_restricted' | 'empty_content' }
  | { outcome: 'dependency_failure'; reason: 'upstream_failure' | 'malformed_content' | 'cancelled' }
  | { outcome: 'unknown_upstream_acceptance'; reason: 'timeout' | 'cancelled' | 'network_failure' };

export interface VakitekMetadata {
  source: 'vakitek';
  mode: 'native';
  requestId: string;
  upstreamStatus: number | null;
  billableCredits: number | null;
  billingKind: 'unknown' | 'reported';
  latencyMs: number;
}

export type VakitekTranscriptResult = { metadata: VakitekMetadata } & (
  | { outcome: 'success'; reason: 'native_captions'; segments: { text: string; start: number; duration: number }[];
      language?: string; availableLanguages?: string[] }
  | VakitekFailure
);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapErrorCode(code: string): VakitekFailure {
  switch (code) {
    case 'NO_CAPTIONS': return { outcome: 'unavailable', reason: 'no_captions' };
    case 'LANGUAGE_NOT_AVAILABLE': return { outcome: 'unavailable', reason: 'language_not_available' };
    case 'NOT_FOUND': return { outcome: 'unavailable', reason: 'not_found' };
    case 'PRIVATE': return { outcome: 'unavailable', reason: 'private' };
    case 'MEMBERS_ONLY': return { outcome: 'unavailable', reason: 'members_only' };
    case 'AGE_RESTRICTED': return { outcome: 'unavailable', reason: 'age_restricted' };
    default: return { outcome: 'dependency_failure', reason: 'upstream_failure' };
  }
}

/** Exactly one native-only attempt. Captions-only vendor; never generates/transcribes audio. */
export async function fetchVakitekTranscript(input: {
  videoId: string; lang?: string; apiKey: string; requestId: string; signal?: AbortSignal;
}): Promise<VakitekTranscriptResult> {
  const started = Date.now();
  const metadata: VakitekMetadata = {
    source: 'vakitek', mode: 'native', requestId: input.requestId,
    upstreamStatus: null, billableCredits: null, billingKind: 'unknown', latencyMs: 0,
  };
  const failure = (result: VakitekFailure): VakitekTranscriptResult => ({ ...result, metadata });
  if (input.signal?.aborted) return failure({ outcome: 'dependency_failure', reason: 'cancelled' });

  const abortManager = new AbortManager();
  const controller = abortManager.createController('vakitek', VAKITEK_TIMEOUT_MS);
  let rejectWaiting: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectWaiting = () => reject(new Error('interrupted'));
  });
  controller.signal.addEventListener('abort', rejectWaiting, { once: true });
  const onCancel = () => controller.abort();
  input.signal?.addEventListener('abort', onCancel, { once: true });

  console.info(JSON.stringify({ event: 'vakitek_transcript_started', source: 'vakitek', mode: 'native', requestId: input.requestId }));
  let finished = false;
  const attempt = async (): Promise<VakitekTranscriptResult> => {
    const url = new URL('https://api.vakitek.co.uk/v1/youtube/transcript');
    url.searchParams.set('video', input.videoId);
    url.searchParams.set('format', 'json');
    if (input.lang) url.searchParams.set('target_language', input.lang);
    const response = await fetch(url.toString(), {
      method: 'GET', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'X-API-Key': input.apiKey },
    });
    // A late response must not mutate an already-emitted timeout result.
    if (finished) return failure({ outcome: 'unknown_upstream_acceptance', reason: 'timeout' });
    metadata.upstreamStatus = response.status;
    if (response.status !== 200) return failure({ outcome: 'dependency_failure', reason: 'upstream_failure' });

    let body: unknown;
    try { body = await response.json(); } catch {
      return failure({ outcome: 'dependency_failure', reason: 'malformed_content' });
    }
    if (finished) return failure({ outcome: 'unknown_upstream_acceptance', reason: 'timeout' });
    if (!record(body) || !Array.isArray(body.data) || body.data.length === 0) {
      return failure({ outcome: 'dependency_failure', reason: 'malformed_content' });
    }
    if (record(body.billing) && record(body.billing.events) &&
      typeof body.billing.events.transcript === 'number' && Number.isFinite(body.billing.events.transcript)) {
      metadata.billableCredits = body.billing.events.transcript;
      metadata.billingKind = 'reported';
    }
    const item = body.data[0];
    if (!record(item)) return failure({ outcome: 'dependency_failure', reason: 'malformed_content' });
    if (typeof item.error === 'string') return failure(mapErrorCode(item.error));
    if (!Array.isArray(item.transcript)) return failure({ outcome: 'dependency_failure', reason: 'malformed_content' });
    const segments: { text: string; start: number; duration: number }[] = [];
    for (const raw of item.transcript) {
      if (!record(raw) || typeof raw.text !== 'string'
        || typeof raw.start !== 'number' || !Number.isFinite(raw.start) || raw.start < 0
        || typeof raw.dur !== 'number' || !Number.isFinite(raw.dur) || raw.dur < 0) {
        return failure({ outcome: 'dependency_failure', reason: 'malformed_content' });
      }
      const text = raw.text.trim();
      if (!text) return failure({ outcome: 'dependency_failure', reason: 'malformed_content' });
      segments.push({ text, start: raw.start, duration: raw.dur });
    }
    if (segments.length === 0) return failure({ outcome: 'unavailable', reason: 'empty_content' });
    return {
      outcome: 'success', reason: 'native_captions', metadata, segments,
      language: typeof item.language === 'string' ? item.language : undefined,
      availableLanguages: Array.isArray(item.availableLanguages)
        ? item.availableLanguages.filter((lang): lang is string => typeof lang === 'string') : undefined,
    };
  };

  let result: VakitekTranscriptResult;
  try {
    result = await Promise.race([attempt(), interrupted]);
  } catch {
    result = failure({ outcome: 'unknown_upstream_acceptance',
      reason: input.signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'network_failure' });
  } finally {
    finished = true;
    input.signal?.removeEventListener('abort', onCancel);
    controller.signal.removeEventListener('abort', rejectWaiting);
    abortManager.cleanup();
  }
  metadata.latencyMs = Date.now() - started;
  console.info(JSON.stringify({ event: 'vakitek_transcript_completed', ...metadata, outcome: result.outcome, reason: result.reason }));
  return result;
}
