import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  cache: null as any, cacheError: null as any, targetedCacheError: null as any,
  limiterError: null as any, limiterAllowed: true, guestError: null as any,
  profileError: null as any, usageError: null as any, saveError: null as any,
  creditError: null as any, user: null as any, authError: null as any,
  throwConnection: false, guestUsed: false,
  upstream: vi.fn(), topics: vi.fn(), themes: vi.fn(), text: vi.fn(), rpc: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '127.0.0.1' }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user }, error: state.authError }) },
  from: (table: string) => {
    let single = false;
    const result = () => {
      if (state.throwConnection) throw new Error('connection refused secret request body');
      if (table === 'video_analyses') return { data: single ? state.cache : [], error: (single && state.targetedCacheError) || state.cacheError };
      if (table === 'profiles') return { data: { id: 'user-1', subscription_tier: 'free', topup_credits: 0 }, error: state.profileError };
      return { data: null, error: null };
    };
    const query: any = { then: (resolve: any, reject: any) => Promise.resolve().then(result).then(resolve, reject) };
    for (const method of ['select', 'eq', 'gte', 'lte', 'or', 'limit', 'upsert']) query[method] = () => query;
    query.maybeSingle = query.single = () => { single = true; return query; };
    return query;
  },
  rpc: async (name: string) => {
    state.rpc(name);
    if (name === 'get_usage_breakdown') return { data: [], error: state.usageError };
    if (name === 'insert_video_analysis_server') return { data: 'saved-id', error: state.saveError };
    if (name === 'consume_video_credit_atomically') return { data: { allowed: true, generation_id: 'generation-id' }, error: state.creditError };
    throw new Error(`Unexpected RPC ${name}`);
  },
}) }));
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => ({
  rpc: (name: string, args: any) => {
    const result = (async () => {
    state.rpc(name, args);
    if (name === 'check_rate_limit_server') return {
      data: { allowed: state.limiterAllowed, remaining: 2, reset_at: new Date().toISOString(), retry_after: 60 },
      error: state.limiterError,
    };
    if (name === 'guest_usage_server') return { data: state.guestUsed || args.p_record, error: state.guestError };
    if (name === 'reserve_transcript_spend') return { data: { allowed: true, reservation_id: 'test-reservation' }, error: null };
    if (name === 'transition_transcript_spend') return { data: true, error: null };
    if (name === 'validate_initial_analysis_flow' || name === 'transcript_cache_assert_owner' || name === 'transcript_cache_finish') return { data: true, error: null };
    if (name === 'transcript_cache_acquire') return { data: { state: 'leader', owner: '00000000-0000-4000-8000-000000000002' }, error: null };
    if (name === 'claim_initial_analysis_operation' || name === 'finish_initial_analysis_operation') return { data: true, error: null };
    throw new Error(`Unexpected service RPC ${name}`);
    })();
    return Object.assign(result, { abortSignal: () => result });
  },
}) }));
vi.mock('@/lib/ai-processing', () => ({ generateTopicsFromTranscript: state.topics, generateThemesFromTranscript: state.themes }));
vi.mock('@/lib/ai-client', () => ({ generateAIResponse: state.text }));
vi.mock('@/lib/youtube-transcript-provider', () => ({ fetchYouTubeTranscript: async () => null }));
vi.mock('@/lib/mock-data', () => ({ shouldUseMockData: () => false }));
vi.mock('@/lib/translation', () => ({ getTranslationClient: state.upstream }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { logRateLimitExceeded: vi.fn() } }));
vi.mock('@/lib/csrf-protection', () => ({
  validateCSRF: async () => ({ valid: true }), getCSRFTokenFromCookie: () => 'test',
  validateCSRFToken: () => true, injectCSRFToken: (response: any) => ({ response }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error('not-found'); },
}));
vi.mock('@/app/v/[slug]/video-page-client', () => ({ VideoPageClient: () => null }));

import { POST as cache } from '@/app/api/check-video-cache/route';
import { GET as checkLimit } from '@/app/api/check-limit/route';
import { POST as transcript } from '@/app/api/transcript/route';
import { POST as analysis } from '@/app/api/video-analysis/route';
import { POST as summary } from '@/app/api/generate-summary/route';
import { POST as topics } from '@/app/api/generate-topics/route';
import { POST as preview } from '@/app/api/quick-preview/route';
import { POST as questions } from '@/app/api/suggested-questions/route';
import { POST as quotes } from '@/app/api/top-quotes/route';
import { POST as chat } from '@/app/api/chat/route';
import { POST as image } from '@/app/api/generate-image/route';
import { POST as enhance } from '@/app/api/notes/enhance/route';
import { POST as translate } from '@/app/api/translate/route';
import VideoPage from '@/app/v/[slug]/page';
import { ServiceUnavailable } from '@/components/service-unavailable';

const payload = {
  url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk',
  videoInfo: { title: 'Test video', duration: 100 },
  transcript: [{ text: 'A useful insight.', start: 0, duration: 10 }],
};
const request = (path: string, body = payload) => new NextRequest(`http://localhost/api/${path}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json',
    'x-analysis-flow': '00000000-0000-4000-8000-000000000001', 'x-analysis-video': 'abcdefghijk' },
});
const failure = { code: 'exceed_db_size_quota', message: 'sensitive body and credentials' };
const noPaidCalls = () => {
  expect(state.upstream).not.toHaveBeenCalled();
  expect(state.topics).not.toHaveBeenCalled();
  expect(state.themes).not.toHaveBeenCalled();
  expect(state.text).not.toHaveBeenCalled();
};
beforeEach(() => {
  Object.assign(state, { cache: null, cacheError: null, targetedCacheError: null, limiterError: null,
    limiterAllowed: true, guestError: null, profileError: null, usageError: null, saveError: null,
    creditError: null, user: null, authError: null, throwConnection: false, guestUsed: false });
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.topics.mockResolvedValue({ topics: [], candidates: [], modelUsed: 'test' });
  state.themes.mockResolvedValue([]);
  state.text.mockResolvedValue({ content: '{"takeaways":[]}' });
  state.upstream.mockImplementation(async () => Response.json({ content: [{ text: 'A useful insight.', offset: 0, duration: 10 }] }));
  vi.stubGlobal('fetch', state.upstream);
  vi.stubEnv('SUPADATA_API_KEY', 'local-mock-key');
  vi.stubEnv('SUPADATA_SPEND_POLICY', 'native-v1');
});

describe('cache and public-page classification', () => {
  it.each([failure, { code: '42501' }, { code: 'PGRST116' }])('does not convert database errors to absence (%j)', async error => {
    state.cacheError = error;
    const response = await cache(request('check-video-cache'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect((await VideoPage({ params: Promise.resolve({ slug: 'test-abcdefghijk' }) })).type).toBe(ServiceUnavailable);
    noPaidCalls();
  });
  it('handles thrown connection failures', async () => {
    state.throwConnection = true;
    expect((await cache(request('check-video-cache'))).status).toBe(503);
    noPaidCalls();
  });
  it('distinguishes real misses, incomplete found records, and full hits', async () => {
    expect(await (await cache(request('check-video-cache'))).json()).toMatchObject({ status: 'absent', cached: false });
    await expect(VideoPage({ params: Promise.resolve({ slug: 'test-abcdefghijk' }) })).rejects.toThrow('redirect:/analyze/abcdefghijk');
    for (const topicValue of [null, []]) {
      state.cache = { id: 'cached-id', transcript: payload.transcript, topics: topicValue, title: 'Test' };
      expect(await (await cache(request('check-video-cache'))).json()).toMatchObject({ status: 'found', cached: true });
    }
    noPaidCalls();
  });
});

describe('paid admission', () => {
  const routes = { transcript, analysis, summary, topics, preview, questions, quotes, chat, image, enhance, translate };
  for (const [name, route] of Object.entries(routes)) {
    const failures = name === 'enhance' ? ['cacheError', 'limiterError', 'usageError'] as const : ['cacheError', 'limiterError', 'guestError'] as const;
    it.each(failures)(`${name} denies %s before any upstream call`, async field => {
      if (name === 'enhance') state.user = { id: 'user-1' };
      state[field] = failure;
      expect((await route(request(name))).status).toBe(503);
      noPaidCalls();
    });
  }
  it.each(['profileError', 'usageError'] as const)('denies authenticated %s instead of granting default credits', async field => {
    state.user = { id: 'user-1' };
    state[field] = failure;
    expect((await transcript(request('transcript'))).status).toBe(503);
    expect((await checkLimit(new NextRequest('http://localhost/api/check-limit'))).status).toBe(503);
    noPaidCalls();
  });
  it('denies targeted cache failure even after preflight succeeds', async () => {
    state.targetedCacheError = failure;
    expect((await analysis(request('video-analysis'))).status).toBe(503);
    noPaidCalls();
  });
  it('returns 429 for actual exhaustion, then recovers after dependency repair', async () => {
    state.limiterAllowed = false;
    expect((await transcript(request('transcript'))).status).toBe(429);
    noPaidCalls();
    state.limiterAllowed = true;
    state.limiterError = failure;
    expect((await transcript(request('transcript'))).status).toBe(503);
    noPaidCalls();
    state.limiterError = null;
    expect((await transcript(request('transcript'))).status).toBe(200);
    expect(state.upstream).toHaveBeenCalledTimes(1);
  });
  it('serves cached analysis without generating missing themes', async () => {
    state.cache = { id: 'cached-id', transcript: payload.transcript, topics: [], title: 'Test' };
    expect((await analysis(request('video-analysis'))).status).toBe(200);
    noPaidCalls();
  });
  it('keeps free cache reads working when admission persistence fails', async () => {
    state.limiterError = failure;
    expect((await cache(request('check-video-cache'))).status).toBe(200);
    noPaidCalls();
  });
  it.each(['', 'invalid-policy'])('missing/invalid paid policy %s blocks dispatch but leaves cached public reading', async policy => {
    vi.stubEnv('SUPADATA_SPEND_POLICY', policy);
    expect((await transcript(request('transcript'))).status).toBe(503);
    state.cache = { id: 'cached-id', transcript: payload.transcript, topics: [], title: 'Test' };
    expect((await cache(request('check-video-cache'))).status).toBe(200);
    noPaidCalls();
  });
  it('canonicalizes general admission across transcript query variations', async () => {
    await transcript(request('transcript?nonce=1'));
    await transcript(request('transcript?nonce=2'));
    const keys = state.rpc.mock.calls.filter(([name]) => name === 'check_rate_limit_server').map(([, args]) => args.p_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain('ratelimit:/api/transcript:');
  });
  it('transcript-only does not charge; later highlights retain the existing single charging point', async () => {
    state.user = { id: 'user-1' };
    expect((await transcript(request('transcript'))).status).toBe(200);
    expect(state.rpc.mock.calls.filter(([name]) => name === 'consume_video_credit_atomically')).toHaveLength(0);
    expect((await analysis(request('video-analysis'))).status).toBe(200);
    expect(state.rpc.mock.calls.filter(([name]) => name === 'consume_video_credit_atomically')).toHaveLength(1);
    expect(state.topics).toHaveBeenCalledTimes(1);
  });
  it.each(['saveError', 'creditError'] as const)('stops further paid work after post-provider %s', async field => {
    state.user = { id: 'user-1' };
    state[field] = failure;
    const response = await analysis(request('video-analysis'));
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty('noCreditsUsed');
    expect(state.topics).toHaveBeenCalledTimes(1);
    expect(state.themes).not.toHaveBeenCalled();
  });
  it('does not log sensitive database error messages', async () => {
    state.cacheError = failure;
    await transcript(request('transcript'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
  });
});
