import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { transcriptEligibility } from '@/lib/transcript-spend';
import { setGuestCookies } from '@/lib/guest-usage';
import { DependencyUnavailableError, dependencyUnavailable, unavailableResponse } from '@/lib/dependency-unavailable';
import { extractVideoId } from '@/lib/utils';
import { assertInitialAIAdmission, initialAIContext } from '@/lib/initial-ai-context';
import { AbortManager, awaitWithSignal } from '@/lib/promise-utils';

type Operation = 'transcript' | 'summary' | 'preview' | 'questions' | 'highlights' | 'themes';
type Identity = Extract<Awaited<ReturnType<typeof transcriptEligibility>>, { allowed: true }>;
type Flow = { id: string; videoId: string; identity: Identity };
const flowContext = new AsyncLocalStorage<Flow>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class IntentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly resetAt?: string) { super(message); }
}

async function rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const manager = new AbortManager();
  try {
    const combined = signal ? AbortSignal.any([signal, manager.createController('rpc', 5000).signal]) : undefined;
    combined?.throwIfAborted();
    const query = createServiceRoleClient().rpc(name, args);
    const { data, error } = combined ? await awaitWithSignal(query.abortSignal(combined), combined) : await query;
    if (error) throw error;
    return data;
  } catch (error) { throw dependencyUnavailable('initial-analysis-spend', error); }
  finally { manager.cleanup(); }
}

export function initialAnalysisErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof DependencyUnavailableError) {
    const response = unavailableResponse();
    return new NextResponse(response.body, { status: response.status, headers: response.headers });
  }
  if (!(error instanceof IntentError)) return null;
  const retryAfter = error.resetAt ? Math.max(1, Math.ceil((Date.parse(error.resetAt) - Date.now()) / 1000)) : undefined;
  return NextResponse.json({ error: error.message, code: error.code, resetAt: error.resetAt, retryAfter,
    requiresAuth: error.status === 401 }, { status: error.status,
    headers: { 'Cache-Control': 'no-store', ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) } });
}

async function eligible(): Promise<Identity> {
  const identity = await transcriptEligibility();
  if (!identity.allowed) throw new IntentError(identity.requiresAuth ? 401 : 403, 'ANALYSIS_ELIGIBILITY_REQUIRED',
    identity.requiresAuth ? 'Sign in to analyze this video.' : 'Your current video allowance does not permit analysis.');
  return identity;
}

export async function createInitialAnalysisFlow(videoId: unknown): Promise<NextResponse> {
  if (typeof videoId !== 'string' || !/^[\w-]{11}$/.test(videoId)) {
    throw new IntentError(400, 'INVALID_VIDEO', 'A valid video ID is required.');
  }
  const identity = await eligible();
  const flowId = await rpc('create_initial_analysis_flow', { p_video: videoId, p_tier: identity.tier, p_identifiers: identity.identifiers });
  if (flowId === null) throw new IntentError(401, 'ANALYSIS_ELIGIBILITY_REQUIRED', 'Sign in to analyze this video.');
  if (typeof flowId !== 'string' || !uuid.test(flowId)) throw dependencyUnavailable('initial-analysis-response');
  const response = NextResponse.json({ flowId, videoId }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  if (identity.guest) setGuestCookies(response, identity.guest);
  return response;
}

async function operation<T>(flow: Flow, name: Operation, work: () => Promise<T>): Promise<T> {
  if (await rpc('claim_initial_analysis_operation', { p_flow: flow.id, p_video: flow.videoId,
    p_identifiers: flow.identity.identifiers, p_operation: name, p_tier: flow.identity.tier }) !== true) {
    throw new IntentError(409, 'ANALYSIS_INTENT_REQUIRED', 'This analysis request expired or was already used. Start a new analysis.');
  }
  let admissionFailure: unknown;
  // Serialize only admission acknowledgements, not upstream calls. Queued fanout
  // must observe a denial before any later reservation can authorize dispatch.
  let admissionQueue = Promise.resolve();
  const attempt = async <R>(dispatch: () => Promise<R>): Promise<R> => {
    const previousAdmission = admissionQueue;
    let releaseAdmission!: () => void;
    admissionQueue = new Promise<void>(resolve => { releaseAdmission = resolve; });
    await previousAdmission;
    let reservation: string;
    try {
      // A swallowed budget/storage error must never permit a later fallback dispatch.
      if (admissionFailure) throw admissionFailure;
      const result = await rpc('reserve_initial_ai_attempt', { p_flow: flow.id, p_operation: name }) as Record<string, unknown> | null;
      if (result?.allowed === false) {
        if (!['flow', 'operation', 'budget', 'concurrency', 'cooldown'].includes(String(result.reason))) {
          throw dependencyUnavailable('initial-analysis-response');
        }
        const resetAt = typeof result.retry_at === 'string' && Number.isFinite(Date.parse(result.retry_at)) ? result.retry_at : undefined;
        throw new IntentError(429, 'ANALYSIS_SPEND_THROTTLED', 'Analysis generation is paused. Please try again later.', resetAt);
      }
      if (result?.allowed !== true || typeof result.reservation_id !== 'string' || !uuid.test(result.reservation_id)) {
        throw dependencyUnavailable('initial-analysis-response');
      }
      reservation = result.reservation_id;
    } catch (error) { admissionFailure = error; throw error; }
    finally { releaseAdmission(); }
    let result: R;
    try { result = await dispatch(); }
    catch (error) {
      // Known HTTP rejection has an explicit status. Network/timeout/unknown acceptance is quarantined.
      const status = (error as { status?: unknown } | null)?.status;
      const uncertain = typeof status !== 'number' || status < 400 || status >= 500 || status === 408;
      try {
        if (await rpc('finish_initial_ai_attempt', { p_id: reservation, p_uncertain: uncertain }) !== true) {
          throw dependencyUnavailable('initial-analysis-transition');
        }
      } catch (failure) { admissionFailure = failure; throw failure; }
      throw error;
    }
    try {
      if (await rpc('finish_initial_ai_attempt', { p_id: reservation, p_uncertain: false }) !== true) {
        throw dependencyUnavailable('initial-analysis-transition');
      }
    } catch (error) { admissionFailure = error; throw error; }
    return result;
  };
  try {
    const result = await flowContext.run(flow, () => initialAIContext.run({ attempt,
      assertHealthy: () => { if (admissionFailure) throw admissionFailure; } }, work));
    if (admissionFailure) throw admissionFailure;
    return result;
  } finally {
    if (await rpc('finish_initial_analysis_operation', { p_flow: flow.id, p_operation: name }) !== true) {
      throw dependencyUnavailable('initial-analysis-transition');
    }
  }
}

/** Theme discovery belongs to the already admitted highlight journey, after its existing credit write. */
export function initialThemeDiscovery<T>(work: () => Promise<T>): Promise<T> {
  assertInitialAIAdmission();
  const flow = flowContext.getStore();
  return flow ? operation(flow, 'themes', work) : work();
}

/** Defense against a cache changing between the wrapper's check and the route's own lookup. */
export function requireInitialAnalysisContext(): void {
  if (!flowContext.getStore()) throw new IntentError(409, 'ANALYSIS_INTENT_REQUIRED', 'Choose Analyze video to start generation.');
}

/** Protect the complete route invocation, so local error fallbacks cannot hide a failed admission. */
export function withInitialAnalysis(name: Exclude<Operation, 'themes'>,
  handler: (request: NextRequest) => Promise<NextResponse>, options: {
    allowCachedAnalysis?: boolean;
    reuse?: (request: NextRequest, fresh: (signal?: AbortSignal) => Promise<NextResponse>) => Promise<NextResponse>;
  } = {}) {
  return async (request: NextRequest): Promise<NextResponse> => {
    try {
      const body = await request.clone().json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new IntentError(400, 'INVALID_REQUEST', 'A JSON object is required.');
      }
      const flowId = request.headers.get('x-analysis-flow');
      const videoId = request.headers.get('x-analysis-video') ?? body.videoId ?? (typeof body.url === 'string' ? extractVideoId(body.url) : null);
      // Only server-proven existing analyses may use the pre-existing explicit cached/theme path.
      if (options.allowCachedAnalysis && !flowId && typeof body.videoId === 'string' && !body.forceRegenerate) {
        const client = await createClient();
        const { data, error } = await client.from('video_analyses').select('topics').eq('youtube_id', body.videoId).maybeSingle();
        if (error) throw dependencyUnavailable('video-cache', error);
        if (Array.isArray(data?.topics) && data.topics.length > 0) return await handler(request);
      }
      if (!flowId || !uuid.test(flowId) || typeof videoId !== 'string' || !/^[\w-]{11}$/.test(videoId)
        || (body.videoId && body.videoId !== videoId) || (body.url && (typeof body.url !== 'string' || extractVideoId(body.url) !== videoId))) {
        throw new IntentError(409, 'ANALYSIS_INTENT_REQUIRED', 'Choose Analyze video to start generation.');
      }
      const identity = await eligible();
      // Reuse avoids a fresh operation claim, but must still prove capability ownership
      // before touching shared coordination (a forged flow must not strand a lease).
      if (options.reuse && await rpc('validate_initial_analysis_flow', { p_flow: flowId,
        p_video: videoId, p_identifiers: identity.identifiers }, request.signal) !== true) {
        throw new IntentError(409, 'ANALYSIS_INTENT_REQUIRED', 'This analysis request expired or was already used. Start a new analysis.');
      }
      const fresh = (signal?: AbortSignal) => operation({ id: flowId, videoId, identity }, name,
        () => handler(signal ? new NextRequest(request, { signal }) : request));
      return options.reuse ? await options.reuse(request, fresh) : await fresh();
    } catch (error) {
      const response = initialAnalysisErrorResponse(error);
      if (response) return response;
      if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
      throw error;
    }
  };
}
