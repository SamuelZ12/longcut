import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  user: { id: 'one' } as { id: string } | null, eligible: true, tier: 'free', topup: 0, unlimited: false,
  guest: '00000000-0000-4000-8000-000000000001', used: false, rpc: vi.fn(), paid: vi.fn(), direct: vi.fn(),
  topics: vi.fn(), themes: vi.fn(), credits: vi.fn(), save: vi.fn(), cache: null as null | {
    topics: unknown[]; transcript: { text: string; start: number; duration: number }[]; title: string;
  },
  authError: null as unknown, failRpc: '', loseAck: false, denied: vi.fn(), cacheReads: 0, vanishCache: false,
}));
const container = process.env.INITIAL_ANALYSIS_TEST_CONTAINER;
const local = !!container && /^longcut-initial-test-\d+-\d+$/.test(container);
async function sql(text: string): Promise<string> {
  if (!local) throw new Error('Local disposable cluster required');
  const child = execFile('docker', ['exec', '-i', container!, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At']);
  child.stdin!.end(text);
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    child.stdout!.on('data', d => { out += d; }); child.stderr!.on('data', d => { err += d; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(out.trim().split('\n').at(-1)!) : reject(new Error(err)));
  });
}
const quote = (v: unknown) => `'${String(v).replaceAll("'", "''")}'`;
const signatures: Record<string, string[]> = {
  create_initial_analysis_flow: ['p_video', 'p_tier', 'p_identifiers'],
  claim_initial_analysis_operation: ['p_flow', 'p_video', 'p_identifiers', 'p_operation', 'p_tier'],
  finish_initial_analysis_operation: ['p_flow', 'p_operation'],
  reserve_initial_ai_attempt: ['p_flow', 'p_operation'], finish_initial_ai_attempt: ['p_id', 'p_uncertain'],
  reserve_transcript_spend: ['p_policy', 'p_tier', 'p_identifiers', 'p_key'], transition_transcript_spend: ['p_id', 'p_action'],
};
vi.mock('@/lib/security-middleware', () => ({ withSecurity: (h: unknown) => h, SECURITY_PRESETS: { PAID: {} } }));
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => ({ rpc: state.rpc }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user }, error: state.authError }) },
  from: (table: string) => {
    const q = { select: () => q, eq: () => q, gte: () => q, lte: () => q, or: () => q, limit: () => q,
      maybeSingle: async () => ({ data: table === 'video_analyses'
        ? (state.vanishCache && ++state.cacheReads > 1 ? null : state.cache) : null, error: null }) };
    return q;
  },
}) }));
vi.mock('@/lib/subscription-manager', () => ({
  canGenerateVideo: async () => ({ allowed: state.eligible, reason: 'LIMIT_REACHED',
    subscription: { tier: state.tier, topupCredits: state.topup }, stats: { totalRemaining: 3 } }),
  consumeVideoCreditAtomic: state.credits,
}));
vi.mock('@/lib/access-control', () => ({ hasUnlimitedVideoAllowance: () => state.unlimited }));
vi.mock('@/lib/guest-usage', () => ({
  getGuestAccessState: async () => ({ used: state.used, token: state.guest, tokenNeedsSet: false, identifiers: [state.guest, 'ip:local'] }),
  setGuestCookies: vi.fn(), recordGuestUsage: async () => { state.used = true; },
}));
vi.mock('@/lib/video-save-utils', () => ({ saveVideoAnalysisWithRetry: state.save }));
vi.mock('@/lib/ai-processing', () => ({ generateTopicsFromTranscript: state.topics, generateThemesFromTranscript: state.themes }));
vi.mock('@/lib/youtube-transcript-provider', () => ({ fetchYouTubeTranscript: state.direct }));
vi.mock('@/lib/mock-data', () => ({ shouldUseMockData: () => false }));
import { POST as intent } from '@/app/api/analysis-intents/route';
import { POST as summary } from '@/app/api/generate-summary/route';
import { POST as preview } from '@/app/api/quick-preview/route';
import { POST as questions } from '@/app/api/suggested-questions/route';
import { POST as topics } from '@/app/api/generate-topics/route';
import { POST as analysis } from '@/app/api/video-analysis/route';
import { POST as transcript } from '@/app/api/transcript/route';
import { initialAIAttempt } from '@/lib/initial-ai-context';
import { withInitialAnalysis } from '@/lib/initial-analysis-spend';
import { NextResponse } from 'next/server';
import { generateAIResponse } from '@/lib/ai-client';

const videoId = 'abcdefghijk';
const payload = { videoId, url: `https://youtu.be/${videoId}`, transcript: [{ text: 'Useful sentence.', start: 0, duration: 5 }],
  videoInfo: { title: 'Test video', duration: 5 }, videoTitle: 'Test video' };
const request = (flow?: string, body: unknown = payload, query = '') => new NextRequest(`http://localhost/api/test${query}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json',
    ...(flow ? { 'x-analysis-flow': flow, 'x-analysis-video': videoId } : {}),
    'user-agent': 'human', referer: 'https://longcut.ai',
  },
});
async function newFlow() {
  const res = await intent(request());
  expect(res.status).toBe(201);
  return (await res.json()).flowId as string;
}
const rawFlow = async (tier: string, ids: string[], video = videoId) => sql(`SET ROLE service_role; SELECT public.create_initial_analysis_flow(${quote(video)},${quote(tier)},ARRAY[${ids.map(quote)}])`);
const claim = async (id: string, ids: string[], op = 'highlights') => {
  const tier = await sql(`SELECT tier FROM public.initial_analysis_flows WHERE id='${id}'`);
  return sql(`SET ROLE service_role; SELECT public.claim_initial_analysis_operation('${id}','${videoId}',ARRAY[${ids.map(quote)}],'${op}','${tier}')`);
};
const reserve = async (id: string, op = 'highlights') => JSON.parse(await sql(`SET ROLE service_role; SELECT public.reserve_initial_ai_attempt('${id}','${op}')`));
const finish = (id: string, uncertain = false) => sql(`SET ROLE service_role; SELECT public.finish_initial_ai_attempt('${id}',${uncertain})`);

describe.skipIf(!local)('initial-analysis actual PostgreSQL admission and mocked upstream route counters', () => {
  beforeEach(async () => {
    await sql('TRUNCATE public.initial_ai_attempts, public.initial_analysis_operations, public.initial_analysis_flows, public.transcript_spend_attempts, public.guest_analysis_usage CASCADE');
    vi.clearAllMocks();
    Object.assign(state, { user: { id: 'one' }, eligible: true, tier: 'free', topup: 0, unlimited: false, used: false, cache: null,
      failRpc: '', authError: null, loseAck: false, cacheReads: 0, vanishCache: false });
    vi.stubEnv('AI_PROVIDER', 'minimax'); vi.stubEnv('MINIMAX_API_KEY', 'mock'); vi.stubEnv('SUPADATA_API_KEY', 'mock'); vi.stubEnv('SUPADATA_SPEND_POLICY', 'native-v1');
    state.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === state.failRpc) return { error: { code: 'LOCAL_FAILURE' }, data: null };
      if (!signatures[name]) throw new Error(`Unexpected RPC ${name}`);
      const values = signatures[name].map(k => Array.isArray(args[k]) ? `ARRAY[${(args[k] as unknown[]).map(quote)}]::text[]` : quote(args[k]));
      try {
        const out = await sql(`SET ROLE service_role; SELECT public.${name}(${values})`);
        if (name === 'reserve_initial_ai_attempt' && state.loseAck) return { error: { code: 'LOST_ACK' }, data: null };
        if (name === 'reserve_initial_ai_attempt' && out.startsWith('{') && JSON.parse(out).allowed === false) state.denied();
        return { data: out === 't' ? true : out === 'f' ? false : out.startsWith('{') ? JSON.parse(out) : out, error: null };
      } catch (error) { return { data: null, error }; }
    });
    state.paid.mockImplementation(async (url: string) => url.includes('supadata')
      ? Response.json({ content: [{ text: 'Caption.', offset: 0, duration: 1000 }] })
      : Response.json({ choices: [{ message: { content: JSON.stringify({ overview: 'Video overview', questions: ['Why?', 'How?', 'What?'] }) } }] }));
    vi.stubGlobal('fetch', state.paid);
    state.direct.mockResolvedValue(null);
    state.topics.mockImplementation(async () => { await initialAIAttempt(async () => { state.paid('topics'); }); return { topics: [], candidates: [] }; });
    state.themes.mockImplementation(async () => { await initialAIAttempt(async () => { state.paid('themes'); }); return []; });
    state.save.mockResolvedValue({ success: true, videoId: 'saved' }); state.credits.mockResolvedValue({ success: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('denies every direct initial entry point without intent, even forged chat/theme/query payloads', async () => {
    for (const route of [transcript, summary, preview, questions, topics, analysis]) {
      expect((await route(request(undefined, { ...payload, theme: 'bypass', messages: [{ role: 'user', content: 'Hi' }], tier: 'unlimited' }, '?nonce=1'))).status).toBe(409);
    }
    expect(state.paid).not.toHaveBeenCalled(); expect(state.direct).not.toHaveBeenCalled(); expect(state.credits).not.toHaveBeenCalled();
  });
  it.each([true, false])('eligible journey works, aliases/replays cannot double spend (guest=%s)', async guest => {
    if (guest) state.user = null;
    const id = await newFlow();
    expect((await transcript(request(id))).status).toBe(200);
    expect(state.credits).not.toHaveBeenCalled(); expect(state.used).toBe(false);
    expect((await preview(request(id))).status).toBe(200);
    const calls = state.paid.mock.calls.length;
    expect((await preview(request(id, payload, '?nonce=2'))).status).toBe(409);
    expect(state.paid).toHaveBeenCalledTimes(calls);
    expect((await analysis(request(id))).status).toBe(200);
    expect(state.credits).toHaveBeenCalledTimes(guest ? 0 : 1);
    expect(state.used).toBe(guest);
    const final = state.paid.mock.calls.length;
    expect([401, 409]).toContain((await topics(request(id))).status);
    expect([401, 409]).toContain((await questions(request(id))).status);
    expect(state.paid).toHaveBeenCalledTimes(final);
    expect(await sql('SELECT count(*) FROM public.initial_ai_attempts')).toBe('3');
  });
  it('binds capability to principal and video, not shared IP/referrer/user agent', async () => {
    state.user = null; const id = await newFlow(); state.guest = randomUUID();
    expect((await preview(request(id))).status).toBe(409);
    state.user = { id: 'other' }; expect((await preview(request(id))).status).toBe(409);
    expect((await transcript(request(id, { ...payload, url: 'https://youtu.be/other123456' }))).status).toBe(409);
    expect(state.paid).not.toHaveBeenCalled();
  });
  it.each(['create_initial_analysis_flow', 'claim_initial_analysis_operation', 'reserve_initial_ai_attempt'])('storage failure %s dispatches nothing', async name => {
    const id = name === 'create_initial_analysis_flow' ? undefined : await newFlow();
    state.failRpc = name;
    expect((await (id ? preview(request(id)) : intent(request()))).status).toBe(503);
    expect(state.paid).not.toHaveBeenCalled();
  });
  it('rejects ineligible or unverifiable identities without calls', async () => {
    state.eligible = false; expect((await intent(request())).status).toBe(403);
    state.user = null; state.used = true; expect((await intent(request())).status).toBe(401);
    state.authError = new Error('auth down'); expect((await intent(request())).status).toBe(503);
    expect(state.paid).not.toHaveBeenCalled();
  });
  it('keeps save-before-credit-before-theme ordering and stops on persistence failure', async () => {
    const id = await newFlow(); state.save.mockResolvedValue({ success: false });
    expect((await analysis(request(id))).status).toBe(503);
    expect(state.credits).not.toHaveBeenCalled(); expect(state.themes).not.toHaveBeenCalled();
    expect(state.paid).toHaveBeenCalledTimes(1);
  });
  it.each([['free',0,false,1],['free',5,false,1],['pro',0,false,1],['free',0,true,0]])(
    'preserves customer charging for tier=%s topup=%s unlimited=%s', async (tier, topup, unlimited, chargeCount) => {
      Object.assign(state, { tier, topup, unlimited });
      expect((await analysis(request(await newFlow()))).status).toBe(200);
      expect(state.credits).toHaveBeenCalledTimes(Number(chargeCount));
      expect(state.save.mock.invocationCallOrder[0]).toBeLessThan(state.themes.mock.invocationCallOrder[0]);
      if (chargeCount) {
        expect(state.save.mock.invocationCallOrder[0]).toBeLessThan(state.credits.mock.invocationCallOrder[0]);
        expect(state.credits.mock.invocationCallOrder[0]).toBeLessThan(state.themes.mock.invocationCallOrder[0]);
      }
    });
  it('preserves explicit cached/theme operations but binds theme input to server cache', async () => {
    state.user = null; state.used = true;
    state.cache = { topics: [{ title: 'Cached' }], transcript: payload.transcript, title: 'Cached video' };
    expect((await analysis(request())).status).toBe(200);
    expect(state.paid).not.toHaveBeenCalled();
    expect((await analysis(request(undefined, { ...payload, theme: 'explicit', transcript: [{ text: 'Forged source', start: 0, duration: 5 }] }))).status).toBe(200);
    expect(state.topics).toHaveBeenCalledWith(payload.transcript, expect.objectContaining({ videoInfo: expect.objectContaining({ title: 'Cached video' }) }));
    expect(state.credits).not.toHaveBeenCalled();
    expect((await analysis(request(undefined, { ...payload, forceRegenerate: true }))).status).toBe(409);
    expect(state.paid).toHaveBeenCalledTimes(1);
  });
  it('a disappearing cache cannot turn explicit cached access into unadmitted generation', async () => {
    state.cache = { topics: [{ title: 'Cached' }], transcript: payload.transcript, title: 'Cached video' }; state.vanishCache = true;
    expect((await analysis(request(undefined, { ...payload, theme: 'explicit' }))).status).toBe(409);
    expect(state.paid).not.toHaveBeenCalled(); expect(state.credits).not.toHaveBeenCalled();
  });
  it('lost reservation acknowledgement permits no dispatch and retains possible spend', async () => {
    const id = await newFlow(); state.loseAck = true;
    expect((await preview(request(id))).status).toBe(503);
    expect(state.paid).not.toHaveBeenCalled();
    expect(await sql('SELECT count(*) FROM public.initial_ai_attempts')).toBe('1');
  });
  it('actual database insert denial fails closed before any provider dispatch', async () => {
    const id = await newFlow();
    await sql('REVOKE INSERT ON public.initial_ai_attempts FROM transcript_spend_executor');
    try {
      expect((await preview(request(id))).status).toBe(503);
      expect(state.paid).not.toHaveBeenCalled();
      expect(await sql('SELECT count(*) FROM public.initial_ai_attempts')).toBe('0');
    } finally { await sql('GRANT INSERT ON public.initial_ai_attempts TO transcript_spend_executor'); }
  });
  it('lost completion acknowledgement prevents any retry/fallback dispatch', async () => {
    const id = await newFlow(); state.failRpc = 'finish_initial_ai_attempt';
    expect((await preview(request(id))).status).toBe(503);
    expect(state.paid).toHaveBeenCalledTimes(1);
    expect(await sql("SELECT state FROM public.initial_ai_attempts")).toBe('dispatched');
  });
  it('guest cookie resets share IP budget and IP changes preserve token usage', async () => {
    const seed = await rawFlow('guest', ['token:one','ip:one']);
    await sql(`INSERT INTO public.initial_ai_attempts(flow_id,operation,identifiers,request_key,counted_at,state,lease_until,blocked_until)
      SELECT '${seed}','summary',ARRAY['token:one','ip:one'],'seed',now(),'complete',now(),now() FROM generate_series(1,12)`);
    for (const ids of [['token:reset','ip:one'],['token:one','ip:changed']]) {
      const id = await rawFlow('guest', ids); await claim(id, ids);
      expect((await reserve(id)).reason).toBe('budget');
    }
  });
  it('counts actual provider fallbacks and refuses a third summary attempt even if caught', async () => {
    const route = withInitialAnalysis('summary', async () => {
      for (let i = 0; i < 5; i++) { try { await initialAIAttempt(async () => { state.paid('attempt'); }); } catch {} }
      return NextResponse.json({ fallback: true });
    });
    expect((await route(request(await newFlow()))).status).toBe(429);
    expect(state.paid).toHaveBeenCalledTimes(2);
    expect(await sql('SELECT count(*) FROM public.initial_ai_attempts')).toBe('2');
  });
  it('real MiniMax -> Grok fallback consumes two attempts; preview cannot dispatch fallback', async () => {
    vi.stubEnv('XAI_API_KEY', 'mock'); vi.stubEnv('GEMINI_API_KEY', '');
    const takeaways = Array.from({ length: 4 }, (_, i) => ({ label: `Point ${i}`, insight: 'Useful insight', timestamps: ['00:01'] }));
    state.paid.mockImplementation(async (url: string) => url.includes('minimax')
      ? Response.json({ error: { message: 'rate limit' } }, { status: 429 })
      : Response.json({ choices: [{ message: { content: JSON.stringify(takeaways) } }] }));
    expect((await summary(request(await newFlow()))).status).toBe(200);
    expect(state.paid).toHaveBeenCalledTimes(2);
    expect(await sql('SELECT count(*) FROM public.initial_ai_attempts')).toBe('2');
    state.paid.mockClear();
    expect((await preview(request(await newFlow()))).status).toBe(429);
    expect(state.paid).toHaveBeenCalledTimes(1);
  });
  it('real Gemini model cascade cannot dispatch a third summary attempt', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'mock');
    state.paid.mockResolvedValue(Response.json({ error: { message: 'rate limit' } }, { status: 429 }));
    const route = withInitialAnalysis('summary', async () => {
      try { await generateAIResponse('Test prompt', { provider: 'gemini' }); } catch {}
      return NextResponse.json({});
    });
    expect((await route(request(await newFlow()))).status).toBe(429);
    expect(state.paid).toHaveBeenCalledTimes(2);
    expect(await sql('SELECT count(*) FROM public.initial_ai_attempts')).toBe('2');
  });
  it('real chunk and reduction pipeline accounts each adapter dispatch', async () => {
    const actual = await vi.importActual<typeof import('@/lib/ai-processing')>('@/lib/ai-processing');
    state.topics.mockImplementation((source, options) => actual.generateTopicsFromTranscript(source, {
      ...options, chunkDurationSeconds: 1800, chunkOverlapSeconds: 0,
    }));
    let call = 0;
    state.paid.mockImplementation(async () => {
      const n = call++;
      const content = n < 2 ? [{ title: `Topic ${n}`, quote: { timestamp: n ? '[30:00-31:00]' : '[00:00-01:00]', text: `Sentence ${n ? 30 : 0}.` } }]
        : [{ candidateIndex: 1, title: 'Selected topic' }];
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    });
    const source = Array.from({ length: 40 }, (_, i) => ({ text: `Sentence ${i}.`, start: i * 60, duration: 60 }));
    state.tier = 'pro';
    const response = await topics(request(await newFlow(), { ...payload, transcript: source, mode: 'fast' }));
    expect(response.status).toBe(200);
    expect(state.paid.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(state.paid.mock.calls.length).toBeLessThanOrEqual(6);
    expect(Number(await sql('SELECT count(*) FROM public.initial_ai_attempts'))).toBe(state.paid.mock.calls.length);
  });
  it('real large chunk fanout stops at concurrent budget, including swallowed errors and fallback', async () => {
    const actual = await vi.importActual<typeof import('@/lib/ai-processing')>('@/lib/ai-processing');
    state.topics.mockImplementation(actual.generateTopicsFromTranscript);
    vi.stubEnv('XAI_API_KEY', 'mock');
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    state.paid.mockImplementation(async () => { await waiting; return Response.json({ choices: [{ message: { content: '[]' } }] }); });
    const source = Array.from({ length: 100 }, (_, i) => ({ text: `Sentence ${i}.`, start: i * 120, duration: 120 }));
    const pending = analysis(request(await newFlow(), { ...payload, transcript: source, mode: 'fast' }));
    await vi.waitFor(() => expect(state.paid).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(() => expect(state.denied).toHaveBeenCalled(), { timeout: 5000 });
    release();
    expect((await pending).status).toBe(429);
    expect(state.save).not.toHaveBeenCalled(); expect(state.credits).not.toHaveBeenCalled(); expect(state.themes).not.toHaveBeenCalled();
    expect(state.paid).toHaveBeenCalledTimes(2);
    expect(await sql('SELECT count(*) FROM public.initial_ai_attempts')).toBe('2');
  });
  it('expired flows and changing customer tiers cannot resurrect old capacity', async () => {
    const id = await newFlow();
    await sql(`UPDATE public.initial_analysis_flows SET expires_at=now()-interval '1 second' WHERE id='${id}'`);
    expect((await preview(request(id))).status).toBe(409);
    expect(state.paid).not.toHaveBeenCalled();
    state.tier = 'pro'; const upgraded = await newFlow(); state.tier = 'free';
    expect((await preview(request(upgraded))).status).toBe(200);
    expect(await sql(`SELECT tier FROM public.initial_analysis_flows WHERE id='${upgraded}'`)).toBe('free');
  });
  it('quarantines uncertain acceptance across identities and keeps its unit', async () => {
    state.paid.mockRejectedValue(new Error('lost connection'));
    await preview(request(await newFlow()));
    state.user = { id: 'two' };
    expect((await preview(request(await newFlow()))).status).toBe(429);
    expect(state.paid).toHaveBeenCalledTimes(1);
    expect(await sql("SELECT count(*) FROM public.initial_ai_attempts WHERE state='uncertain'")).toBe('1');
  });
  it('serializes parallel operation claims; independent routes cannot replay', async () => {
    const id = await newFlow();
    const responses = await Promise.all(Array.from({ length: 8 }, () => preview(request(id))));
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect(state.paid).toHaveBeenCalledTimes(1);
  });
  it('enforces every per-operation cap and twelve attempts per flow', async () => {
    const id = await rawFlow('unlimited', ['user:matrix']);
    for (const [op, count] of [['summary', 2], ['preview', 1], ['questions', 1], ['highlights', 6], ['themes', 2]] as const) {
      expect(await claim(id, ['user:matrix'], op)).toBe('t');
      for (let i = 0; i < count; i++) { const r = await reserve(id, op); expect(r.allowed).toBe(true); await finish(r.reservation_id); }
      expect((await reserve(id, op)).reason).toBe('operation');
    }
    expect(await sql('SELECT count(*) FROM public.initial_ai_attempts')).toBe('12');
  });
  it.each([['guest',12,36,2],['free',36,180,2],['topup',180,1800,4],['pro',180,1800,4],['unlimited',360,3600,4]])(
    '%s rolling windows and independent-connection concurrency', async (tier, day, month, concurrent) => {
      const ids = ['user:matrix']; const id = await rawFlow(String(tier), ids); await claim(id, ids);
      const results = await Promise.all(Array.from({ length: 8 }, () => reserve(id)));
      expect(results.filter(r => r.allowed)).toHaveLength(Number(concurrent));
      await sql('TRUNCATE public.initial_ai_attempts');
      for (const [count, age] of [[day, '1 hour'], [month, '2 days']]) {
        await sql(`INSERT INTO public.initial_ai_attempts(flow_id,operation,identifiers,request_key,counted_at,state,lease_until,blocked_until)
          SELECT '${id}','summary',ARRAY['user:matrix'],'other',now()-interval '${age}','complete',now(),now() FROM generate_series(1,${count})`);
        // Different flow avoids the per-flow ceiling, but cannot reset identity usage.
        const fresh = await rawFlow(String(tier), ids); await claim(fresh, ids);
        expect((await reserve(fresh)).reason).toBe('budget');
        await sql("UPDATE public.initial_ai_attempts SET counted_at=now()-interval '31 days'");
        expect((await reserve(fresh)).allowed).toBe(true);
        await sql('TRUNCATE public.initial_ai_attempts');
      }
    });
  it('global windows and global concurrent attempts remain bounded', async () => {
    const flows = await Promise.all(Array.from({ length: 24 }, (_, i) => rawFlow('unlimited', [`user:${i}`])));
    await Promise.all(flows.map((id, i) => claim(id, [`user:${i}`])));
    // Use distinct operations' request keys/videos to avoid same-video coalescing cooldown.
    await Promise.all(flows.map((id, i) => sql(`UPDATE public.initial_analysis_flows SET video_id='video${String(i).padStart(6,'0')}' WHERE id='${id}'`)));
    const results = await Promise.all(flows.map(id => reserve(id)));
    expect(results.filter(r => r.allowed)).toHaveLength(20);
    for (const [count, age] of [[1200,'1 hour'],[30000,'2 days']]) {
      await sql('TRUNCATE public.initial_ai_attempts');
      await sql(`INSERT INTO public.initial_ai_attempts(flow_id,operation,identifiers,request_key,counted_at,state,lease_until,blocked_until)
        SELECT '${flows[0]}','summary',ARRAY['other:'||i],'other',now()-interval '${age}','complete',now(),now() FROM generate_series(1,${count}) i`);
      expect((await reserve(flows[1])).reason).toBe('budget');
    }
  });
  it('database privilege boundary denies browser roles and table mutation by service_role', async () => {
    for (const role of ['anon','authenticated']) {
      for (const table of ['initial_analysis_flows','initial_analysis_operations','initial_ai_attempts']) {
        await expect(sql(`SET ROLE ${role}; SELECT * FROM public.${table}`)).rejects.toThrow(/permission denied/);
      }
      await expect(sql(`SET ROLE ${role}; SELECT public.create_initial_analysis_flow('${videoId}','unlimited',ARRAY['forged'])`)).rejects.toThrow(/permission denied/);
      for (const call of [`claim_initial_analysis_operation('${randomUUID()}','${videoId}',ARRAY['forged'],'summary','unlimited')`,
        `reserve_initial_ai_attempt('${randomUUID()}','summary')`, `finish_initial_analysis_operation('${randomUUID()}','summary')`,
        `finish_initial_ai_attempt('${randomUUID()}',false)`]) await expect(sql(`SET ROLE ${role}; SELECT public.${call}`)).rejects.toThrow(/permission denied/);
    }
    await expect(sql("SET ROLE service_role; UPDATE public.initial_analysis_flows SET tier='unlimited'")).rejects.toThrow(/permission denied/);
    expect(await sql("SELECT pg_has_role('migration_executor','transcript_spend_executor','SET') OR pg_has_role('migration_executor','transcript_spend_executor','USAGE')")).toBe('f');
  });
});
