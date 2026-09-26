import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  rpc: vi.fn(), paid: vi.fn(), direct: vi.fn(), credits: vi.fn(), save: vi.fn(), recordGuest: vi.fn(), tableAccess: vi.fn(),
  user: { id: 'one' } as { id: string } | null, eligible: true, used: false, authError: null as unknown,
  failRpc: '', lostAck: '', fastPoll: false, clockOffset: 0,
}));
vi.mock('@/lib/security-middleware', () => ({ withSecurity: (handler: unknown) => handler, SECURITY_PRESETS: { PAID: {} } }));
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => ({ rpc: (...args: unknown[]) => {
  const result = state.rpc(...args);
  return Object.assign(result, { abortSignal: () => result });
} }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user }, error: state.authError }) }, from: state.tableAccess,
}) }));
vi.mock('@/lib/subscription-manager', () => ({
  canGenerateVideo: async () => ({ allowed: state.eligible, reason: 'LIMIT_REACHED', subscription: { tier: 'free', topupCredits: 0 } }),
  consumeVideoCreditAtomic: state.credits,
}));
vi.mock('@/lib/access-control', () => ({ hasUnlimitedVideoAllowance: () => false }));
vi.mock('@/lib/guest-usage', () => ({
  getGuestAccessState: async () => ({ used: state.used, token: '00000000-0000-4000-8000-000000000001',
    tokenNeedsSet: false, identifiers: ['guest:one', 'ip:local'] }),
  setGuestCookies: vi.fn(), recordGuestUsage: state.recordGuest,
}));
vi.mock('@/lib/video-save-utils', () => ({ saveVideoAnalysisWithRetry: state.save }));
vi.mock('@/lib/youtube-transcript-provider', () => ({ fetchYouTubeTranscript: state.direct }));
vi.mock('@/lib/mock-data', () => ({ shouldUseMockData: () => false }));
// Advance only the follower's wall-clock budget when requested. Database clocks
// and actual PostgreSQL IO stay real; normal coalescing tests use real delays.
vi.mock('node:timers/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: async (ms: number, value: unknown, options?: { signal?: AbortSignal }) => {
    if (state.fastPoll) { options?.signal?.throwIfAborted(); state.clockOffset += 26_000; return value; }
    return actual.setTimeout(ms, value, options);
  } };
});
import { POST as transcript } from '@/app/api/transcript/route';
import { POST as intent } from '@/app/api/analysis-intents/route';
import { SUPADATA_TIMEOUT_MS, supadataNativeCacheIdentity } from '@/lib/supadata-transcript-provider';

const container = process.env.TRANSCRIPT_CACHE_TEST_CONTAINER;
const local = !!container && /^longcut-cache-test-\d+-\d+$/.test(container);
function sql(text: string): Promise<string> {
  if (!local) throw new Error('Disposable local PostgreSQL required');
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', container!, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim().split('\n').at(-1) ?? ''));
    child.stdin!.end(text);
  });
}
const quote = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
const signatures: Record<string, string[]> = {
  create_initial_analysis_flow: ['p_video', 'p_tier', 'p_identifiers'],
  validate_initial_analysis_flow: ['p_flow', 'p_video', 'p_identifiers'],
  claim_initial_analysis_operation: ['p_flow', 'p_video', 'p_identifiers', 'p_operation', 'p_tier'],
  finish_initial_analysis_operation: ['p_flow', 'p_operation'],
  reserve_transcript_spend: ['p_policy', 'p_tier', 'p_identifiers', 'p_key'], transition_transcript_spend: ['p_id', 'p_action'],
  transcript_cache_acquire: ['p_key', 'p_refresh'], transcript_cache_read: ['p_key'],
  transcript_cache_assert_owner: ['p_key', 'p_owner'], transcript_cache_finish: ['p_key', 'p_owner', 'p_payload', 'p_uncertain'],
};
const video = 'abcdefghijk';
const request = (flow?: string, extra: Record<string, unknown> = {}) => new NextRequest('http://localhost/api/transcript', {
  method: 'POST', body: JSON.stringify({ videoId: video, url: `https://youtu.be/${video}`, ...extra }),
  headers: { 'Content-Type': 'application/json', ...(flow ? { 'x-analysis-flow': flow, 'x-analysis-video': video } : {}) },
});
const newFlow = async () => {
  const response = await intent(request());
  expect(response.status).toBe(201);
  return (await response.json()).flowId as string;
};
const calls = (name: string) => state.rpc.mock.calls.filter(([rpc]) => rpc === name);
const vendorResponse = (lang = 'en') => Response.json({ content: [{ text: `Caption ${lang}.`, offset: 0, duration: 5000 }],
  lang, availableLangs: ['en', 'es'] });
const count = (table: string) => sql(`SELECT count(*) FROM public.${table}`);

describe.skipIf(!local)('real transcript route + cache/spend RPCs on independent PostgreSQL processes', () => {
  beforeEach(async () => {
    await sql('TRUNCATE public.transcript_cache, public.initial_ai_attempts, public.initial_analysis_operations, public.initial_analysis_flows, public.transcript_spend_attempts, public.guest_analysis_usage CASCADE');
    vi.resetAllMocks();
    Object.assign(state, { user: { id: 'one' }, eligible: true, used: false, authError: null, failRpc: '', lostAck: '', fastPoll: false, clockOffset: 0 });
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + state.clockOffset);
    vi.stubEnv('SUPADATA_API_KEY', 'mock'); vi.stubEnv('SUPADATA_SPEND_POLICY', 'native-v1');
    state.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (!signatures[name]) throw new Error(`Unexpected RPC ${name}`);
      if (name === state.failRpc) return { data: null, error: { code: 'LOCAL_FAILURE' } };
      const values = signatures[name].map(k => args[k] === null ? 'NULL'
        : k === 'p_payload' ? `${quote(JSON.stringify(args[k]))}::jsonb`
        : Array.isArray(args[k]) ? `ARRAY[${(args[k] as unknown[]).map(quote)}]::text[]` : quote(args[k]));
      try {
        const out = await sql(`SET ROLE service_role; SELECT public.${name}(${values})`);
        if (name === state.lostAck) return { data: null, error: { code: 'LOST_ACK' } };
        return { data: out === 't' ? true : out === 'f' ? false : out.startsWith('{') ? JSON.parse(out) : out, error: null };
      } catch (error) { return { data: null, error }; }
    });
    state.paid.mockImplementation(async (url: string) => {
      expect(new URL(url).hostname).toBe('api.supadata.ai');
      return vendorResponse(new URL(url).searchParams.get('lang') ?? 'en');
    });
    vi.stubGlobal('fetch', state.paid);
    state.direct.mockResolvedValue(null);
    state.tableAccess.mockImplementation(() => { throw new Error('Transcript route must not access customer tables'); });
  });
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    expect(state.credits).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled();
    expect(state.recordGuest).not.toHaveBeenCalled(); expect(state.tableAccess).not.toHaveBeenCalled();
    expect(await count('guest_analysis_usage')).toBe('0');
    expect(await count('initial_ai_attempts')).toBe('0');
    expect(await sql('SELECT private_data FROM public.video_analyses WHERE id=1')).toBe('private sentinel');
    expect(await count('video_analyses')).toBe('1');
  });

  it.each([false, true])('transcript-only reload with new flow reuses payload/metadata without vendor or operation claim (guest=%s)', async guest => {
    if (guest) state.user = null;
    const firstFlow = await newFlow();
    const first = await transcript(request(firstFlow));
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.availableLanguages).toEqual(['en', 'es']);
    expect(await count('transcript_cache')).toBe('1');
    const reloadFlow = await newFlow();
    expect(reloadFlow).not.toBe(firstFlow);
    state.rpc.mockClear(); state.paid.mockClear(); state.direct.mockClear();
    const reload = await transcript(request(reloadFlow));
    expect(reload.status).toBe(200);
    const cached = await reload.json();
    expect(cached).toMatchObject({ transcript: body.transcript, availableLanguages: body.availableLanguages, language: body.language, transcriptCache: 'hit' });
    expect(cached.requestId).not.toBe(body.requestId);
    expect(reload.headers.get('Cache-Control')).toBe('no-store');
    expect(state.paid).not.toHaveBeenCalled(); expect(state.direct).not.toHaveBeenCalled();
    expect(calls('claim_initial_analysis_operation')).toHaveLength(0);
    expect(calls('reserve_transcript_spend')).toHaveLength(0);
    expect(await count('initial_analysis_operations')).toBe('1');
    expect(await count('transcript_spend_attempts')).toBe('1');
  });

  it('parallel real route requests share one vendor call and one reservation; followers never claim operations', async () => {
    const flows = await Promise.all(Array.from({ length: 6 }, () => newFlow()));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    state.paid.mockImplementation(async () => { await gate; return vendorResponse(); });
    const leader = transcript(request(flows[0]));
    await vi.waitFor(() => expect(state.paid).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const followers = flows.slice(1).map(flow => transcript(request(flow)));
    try {
      await vi.waitFor(() => expect(calls('transcript_cache_acquire')).toHaveLength(6), { timeout: 5000 });
      await vi.waitFor(() => expect(calls('transcript_cache_read').length).toBeGreaterThanOrEqual(5), { timeout: 5000 });
    } finally { release(); }
    const responses = await Promise.all([leader, ...followers]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(bodies.filter(body => body.transcriptCache === 'hit')).toHaveLength(5);
    expect(state.paid).toHaveBeenCalledTimes(1); expect(state.direct).toHaveBeenCalledTimes(1);
    expect(calls('reserve_transcript_spend')).toHaveLength(1);
    expect(calls('claim_initial_analysis_operation')).toHaveLength(1);
    expect(await count('transcript_spend_attempts')).toBe('1');
    expect(await count('initial_analysis_operations')).toBe('1');
  });

  it('language variants stay distinct while requested-language casing shares canonical cache identity', async () => {
    for (const lang of ['en', 'es']) {
      const response = await transcript(request(await newFlow(), { lang }));
      expect(response.status).toBe(200); expect((await response.json()).language).toBe(lang);
    }
    const again = await transcript(request(await newFlow(), { lang: 'EN' }));
    expect(again.status).toBe(200); expect((await again.json()).language).toBe('en');
    expect(state.paid).toHaveBeenCalledTimes(2);
    expect(await count('transcript_cache')).toBe('2');
    expect(await count('transcript_spend_attempts')).toBe('2');
  });

  it('direct YouTube success is durably reusable without any vendor reservation', async () => {
    state.direct.mockResolvedValue({ segments: [{ text: 'Free caption.', start: 0, duration: 5 }], language: 'en', availableLanguages: ['en'] });
    expect((await transcript(request(await newFlow()))).status).toBe(200);
    expect((await transcript(request(await newFlow()))).status).toBe(200);
    expect(state.direct).toHaveBeenCalledTimes(1); expect(state.paid).not.toHaveBeenCalled();
    expect(calls('reserve_transcript_spend')).toHaveLength(0);
    expect(await count('transcript_spend_attempts')).toBe('0');
  });

  it('uppercase-first acquisition uses canonical language before publishing a shared result', async () => {
    state.direct.mockImplementation(async (_video: string, lang: string) => ({
      segments: [{ text: lang === 'es' ? 'Hola.' : 'Hello.', start: 0, duration: 5 }],
      language: lang === 'es' ? 'es' : 'en', availableLanguages: ['en', 'es'],
    }));
    const first = await transcript(request(await newFlow(), { lang: 'ES' }));
    expect(first.status).toBe(200);
    expect((await first.json()).language).toBe('es');
    const again = await transcript(request(await newFlow(), { lang: 'es' }));
    expect((await again.json()).transcript[0].text).toBe('Hola.');
    expect(state.direct).toHaveBeenCalledTimes(1);
    expect(state.paid).not.toHaveBeenCalled();
  });

  it('actual provider timeout retains spend and blocks immediate cross-identity retries', async () => {
    const flow = await newFlow();
    state.paid.mockImplementation(() => new Promise<Response>(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = transcript(request(flow));
    await vi.waitFor(() => expect(state.paid).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await vi.advanceTimersByTimeAsync(SUPADATA_TIMEOUT_MS + 1);
    vi.useRealTimers();
    const timeout = await pending;
    expect(timeout.status).toBe(504);
    expect(await timeout.json()).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'timeout' });
    expect(await sql("SELECT state FROM public.transcript_spend_attempts")).toBe('uncertain');
    state.user = { id: 'another' }; state.fastPoll = true;
    const retry = await transcript(request(await newFlow()));
    expect(retry.status).toBe(429);
    expect(Number(retry.headers.get('Retry-After'))).toBeGreaterThan(500);
    expect(state.paid).toHaveBeenCalledTimes(1);
    expect(calls('reserve_transcript_spend')).toHaveLength(1);
    expect(calls('claim_initial_analysis_operation')).toHaveLength(1);
    expect(await sql('SELECT payload IS NULL AND retry_at > clock_timestamp() FROM public.transcript_cache')).toBe('t');
  });

  it.each(['transcript_cache_acquire', 'transcript_cache_read'])('%s errors fail closed without dispatch or operation claims', async name => {
    const flow = await newFlow();
    if (name === 'transcript_cache_read') {
      await sql(`SET ROLE service_role; SELECT public.transcript_cache_acquire(${quote(supadataNativeCacheIdentity(video))})`);
      state.fastPoll = true;
    }
    state.failRpc = name;
    const response = await transcript(request(flow));
    expect(response.status).toBe(503); expect((await response.json()).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(state.paid).not.toHaveBeenCalled(); expect(state.direct).not.toHaveBeenCalled();
    expect(calls('reserve_transcript_spend')).toHaveLength(0);
    expect(calls('claim_initial_analysis_operation')).toHaveLength(0);
  });

  it('actual cache INSERT denial fails closed instead of bypassing database coordination', async () => {
    const flow = await newFlow();
    await sql('REVOKE INSERT ON public.transcript_cache FROM transcript_cache_executor');
    try {
      expect((await transcript(request(flow))).status).toBe(503);
      expect(state.paid).not.toHaveBeenCalled(); expect(state.direct).not.toHaveBeenCalled();
      expect(await count('transcript_spend_attempts')).toBe('0');
    } finally { await sql('GRANT INSERT ON public.transcript_cache TO transcript_cache_executor'); }
  });

  it.each([false, true])('publication failure fails closed; lost acknowledgement=%s never causes redispatch', async lostAck => {
    const flow = await newFlow();
    if (lostAck) state.lostAck = 'transcript_cache_finish'; else state.failRpc = 'transcript_cache_finish';
    const failed = await transcript(request(flow));
    expect(failed.status).toBe(503); expect((await failed.json()).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(state.paid).toHaveBeenCalledTimes(1);
    state.lostAck = ''; state.failRpc = ''; state.fastPoll = true;
    const reload = await transcript(request(await newFlow()));
    expect(reload.status).toBe(lostAck ? 200 : 429);
    expect(state.paid).toHaveBeenCalledTimes(1);
    expect(await count('transcript_spend_attempts')).toBe('1');
    expect(calls('claim_initial_analysis_operation')).toHaveLength(1);
  });

  it('slow direct lookup loses its lease before vendor admission and cannot dispatch', async () => {
    state.direct.mockImplementation(async () => {
      await sql("UPDATE public.transcript_cache SET lease_until=clock_timestamp()-interval '1 second'");
      return null;
    });
    expect((await transcript(request(await newFlow()))).status).toBe(503);
    expect(state.paid).not.toHaveBeenCalled(); expect(calls('reserve_transcript_spend')).toHaveLength(0);
    expect(await count('transcript_spend_attempts')).toBe('0');
    expect(await sql('SELECT payload IS NULL AND retry_at > clock_timestamp() FROM public.transcript_cache')).toBe('t');
  });

  it.each(['refresh', 'new language'])('rejects consumed transcript flow replay for %s without electing or mutating cache', async kind => {
    const flow = await newFlow();
    expect((await transcript(request(flow, { lang: 'en' }))).status).toBe(200);
    const prior = await sql('SELECT jsonb_agg(to_jsonb(c) ORDER BY key) FROM public.transcript_cache c');
    state.rpc.mockClear(); state.direct.mockClear(); state.paid.mockClear();
    const replay = await transcript(request(flow, kind === 'refresh' ? { lang: 'en', refresh: true } : { lang: 'es' }));
    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe('ANALYSIS_INTENT_REQUIRED');
    expect(calls('transcript_cache_acquire')).toHaveLength(0);
    expect(calls('claim_initial_analysis_operation')).toHaveLength(0);
    expect(calls('reserve_transcript_spend')).toHaveLength(0);
    expect(state.direct).not.toHaveBeenCalled(); expect(state.paid).not.toHaveBeenCalled();
    expect(await count('transcript_cache')).toBe('1');
    expect(await sql('SELECT jsonb_agg(to_jsonb(c) ORDER BY key) FROM public.transcript_cache c')).toBe(prior);
    expect(await count('initial_analysis_operations')).toBe('1');
    expect(await count('transcript_spend_attempts')).toBe('1');
  });

  it.each(['forged', 'expired', 'cross-user', 'completed'])('rejects %s flow before shared election without poisoning the cache key', async kind => {
    let flow = await newFlow();
    if (kind === 'forged') flow = randomUUID();
    if (kind === 'expired') await sql(`UPDATE public.initial_analysis_flows SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${quote(flow)}`);
    if (kind === 'cross-user') state.user = { id: 'another' };
    if (kind === 'completed') await sql(`UPDATE public.initial_analysis_flows SET complete=true WHERE id=${quote(flow)}`);
    state.rpc.mockClear();
    const response = await transcript(request(flow));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('ANALYSIS_INTENT_REQUIRED');
    expect(calls('transcript_cache_acquire')).toHaveLength(0);
    expect(await count('transcript_cache')).toBe('0');
    expect(await count('initial_analysis_operations')).toBe('0');
    expect(state.direct).not.toHaveBeenCalled(); expect(state.paid).not.toHaveBeenCalled();
    expect(calls('reserve_transcript_spend')).toHaveLength(0);
  });

  it.each(['ineligible', 'used guest', 'auth failure'])('denies %s before cache access even with a reusable public payload', async reason => {
    expect((await transcript(request(await newFlow()))).status).toBe(200);
    const reloadFlow = await newFlow();
    state.rpc.mockClear(); state.paid.mockClear(); state.direct.mockClear();
    if (reason === 'ineligible') state.eligible = false;
    if (reason === 'used guest') { state.user = null; state.used = true; }
    if (reason === 'auth failure') state.authError = new Error('auth unavailable');
    const response = await transcript(request(reloadFlow));
    expect(response.status).toBe(reason === 'ineligible' ? 403 : reason === 'used guest' ? 401 : 503);
    expect(state.rpc).not.toHaveBeenCalled(); expect(state.paid).not.toHaveBeenCalled(); expect(state.direct).not.toHaveBeenCalled();
  });
});
