import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
// Keep this predecessor suite focused on the native ledger. The initial-analysis DB suite composes both ledgers.
vi.mock('@/lib/initial-analysis-spend', () => ({ withInitialAnalysis: (_operation: unknown, handler: unknown) => handler }));
vi.mock('@/lib/transcript-cache', () => ({ assertTranscriptCacheOwner: async () => {}, reuseTranscript: vi.fn() }));

// Invoked by the disposable-cluster harness; never accepts a database URL or credentials.
const state = vi.hoisted(() => ({ user: { id: 'one' } as { id: string } | null,
  tier: 'free', topup: 0, eligible: true, unlimited: false,
  direct: vi.fn(), upstream: vi.fn(), adminRpc: vi.fn(), customerWrites: vi.fn() }));
const container = process.env.TRANSCRIPT_TEST_CONTAINER;
const localCluster = !!container && /^longcut-spend-test-\d+-\d+$/.test(container);
async function sql(text: string): Promise<string> {
  if (!localCluster) throw new Error('Disposable local cluster required');
  const child = execFile('docker', ['exec', '-i', container!, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At']);
  child.stdin!.end(text);
  return new Promise((resolve, reject) => {
    let output = '', error = '';
    child.stdout!.on('data', data => { output += data; });
    child.stderr!.on('data', data => { error += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim().split('\n').at(-1)!) : reject(new Error(error)));
  });
}
const quote = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  rpc: state.customerWrites,
}) }));
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => ({ rpc: state.adminRpc }) }));
vi.mock('@/lib/paid-work', () => ({ assertPaidDependencies: async () => {} }));
vi.mock('@/lib/subscription-manager', () => ({ canGenerateVideo: async () => ({ allowed: state.eligible,
  reason: 'LIMIT_REACHED', subscription: { tier: state.tier, topupCredits: state.topup } }) }));
vi.mock('@/lib/access-control', () => ({ hasUnlimitedVideoAllowance: () => state.unlimited }));
vi.mock('@/lib/youtube-transcript-provider', () => ({ fetchYouTubeTranscript: state.direct }));
vi.mock('@/lib/mock-data', () => ({ shouldUseMockData: () => false }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { logRateLimitExceeded: vi.fn() } }));
import { POST } from '@/app/api/transcript/route';

const request = (video = 'abcdefghijk', lang = 'en', query = '') => new NextRequest(`http://localhost/api/transcript${query}`, {
  method: 'POST', body: JSON.stringify({ url: `https://youtu.be/${video}`, lang, userId: 'forged', tier: 'unlimited' }),
});
describe.skipIf(!localCluster)('actual transcript route + PostgreSQL spend RPCs + mocked vendor', () => {
  beforeEach(async () => {
    await sql('TRUNCATE public.transcript_spend_attempts, public.rate_limits;');
    vi.clearAllMocks();
    Object.assign(state, { user: { id: 'one' }, tier: 'free', topup: 0, eligible: true, unlimited: false });
    vi.stubEnv('SUPADATA_SPEND_POLICY', 'native-v1'); vi.stubEnv('SUPADATA_API_KEY', 'mock');
    vi.stubEnv('VAKITEK_API_KEY', '');
    state.direct.mockResolvedValue(null);
    state.upstream.mockImplementation(async () => Response.json({ content: [{ text: 'Caption.', offset: 0, duration: 1000 }] }));
    vi.stubGlobal('fetch', state.upstream);
    state.adminRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      // Whitelist SQL signatures; parameter values escaped, no arbitrary SQL or remote transport.
      const signatures: Record<string, string[]> = {
        check_rate_limit_server: ['p_key', 'p_identifier', 'p_window_ms', 'p_max_requests', 'p_consume'],
        guest_usage_server: ['p_identifiers', 'p_record'],
        reserve_transcript_spend: ['p_policy', 'p_tier', 'p_identifiers', 'p_key'],
        transition_transcript_spend: ['p_id', 'p_action'],
      };
      if (!signatures[name]) throw new Error(`Unexpected RPC ${name}`);
      const values = signatures[name].map(key => Array.isArray(args[key])
        ? `ARRAY[${(args[key] as unknown[]).map(quote).join(',')}]::text[]` : quote(args[key]));
      try {
        const output = await sql(`SET ROLE service_role; SELECT public.${name}(${values.join(',')})`);
        return { data: output === 't' ? true : output === 'f' ? false : JSON.parse(output), error: null };
      } catch { return { data: null, error: { code: 'LOCAL_TEST_FAILURE' } }; }
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('counts actual dispatches, denies query/refresh bypass, keeps customer ledger untouched', async () => {
    for (let i = 0; i < 5; i++) expect((await POST(request('abcdefghijk', i % 2 ? 'es' : 'en', `?nonce=${i}&refresh=1`))).status).toBe(200);
    expect((await POST(request('abcdefghijk', 'fr', '?nonce=6'))).status).toBe(429);
    expect(state.upstream).toHaveBeenCalledTimes(5);
    expect(await sql("SELECT count(*) FROM public.transcript_spend_attempts WHERE state='complete'")).toBe('5');
    expect(state.customerWrites).not.toHaveBeenCalled();
  });

  it('bounds parallel route requests using independent database connections', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    state.upstream.mockImplementation(async () => { await waiting; return Response.json({ content: [{ text: 'Caption.', offset: 0, duration: 1000 }] }); });
    const responses = Array.from({ length: 8 }, (_, i) => POST(request(`abcdefghij${i}`, 'en', `?nonce=${i}`)));
    await vi.waitFor(() => expect(state.upstream).toHaveBeenCalledTimes(1), { timeout: 5000 });
    // Wait for the seven denied requests before allowing the leader to complete.
    let completed = 0;
    for (const response of responses) void response.then(() => { completed++; });
    await vi.waitFor(() => expect(completed).toBe(7), { timeout: 5000 });
    release();
    const result = await Promise.all(responses);
    expect(result.filter(r => r.status === 200)).toHaveLength(1);
    expect(result.filter(r => r.status === 429)).toHaveLength(7);
    expect(await sql('SELECT count(*) FROM public.transcript_spend_attempts')).toBe('1');
  });

  it('uncertain dispatch blocks other identities; retries after quarantine cost a new unit', async () => {
    state.upstream.mockRejectedValue(new Error('connection lost'));
    expect((await POST(request())).status).toBe(502);
    state.user = { id: 'two' };
    expect((await POST(request())).status).toBe(429);
    expect(state.upstream).toHaveBeenCalledTimes(1);
    await sql("UPDATE public.transcript_spend_attempts SET lease_until=now()-interval '1 second', blocked_until=now()-interval '1 second'");
    expect((await POST(request())).status).toBe(502);
    expect(state.upstream).toHaveBeenCalledTimes(2);
    expect(await sql("SELECT count(*) FROM public.transcript_spend_attempts WHERE state='uncertain'")).toBe('2');
  });

  it('pre-dispatch cancellation releases; missing configuration never reserves', async () => {
    const controller = new AbortController();
    const rpc = state.adminRpc.getMockImplementation()!;
    state.adminRpc.mockImplementation(async (...args) => {
      const result = await rpc(...args);
      if (args[0] === 'reserve_transcript_spend') controller.abort();
      return result;
    });
    expect((await POST(new NextRequest(request(), { signal: controller.signal }))).status).toBe(503);
    expect(await sql("SELECT count(*) FROM public.transcript_spend_attempts WHERE state='released'")).toBe('1');
    vi.stubEnv('SUPADATA_SPEND_POLICY', '');
    expect((await POST(request())).status).toBe(503);
    expect(await sql('SELECT count(*) FROM public.transcript_spend_attempts')).toBe('1');
    expect(state.upstream).not.toHaveBeenCalled();
  });

  it('fails closed when dispatch transition cannot commit, retaining the reservation', async () => {
    await sql('REVOKE UPDATE ON public.transcript_spend_attempts FROM transcript_spend_executor');
    try {
      expect((await POST(request())).status).toBe(503);
      expect(state.upstream).not.toHaveBeenCalled();
      expect(await sql("SELECT count(*) FROM public.transcript_spend_attempts WHERE state='reserved'")).toBe('1');
    } finally { await sql('GRANT UPDATE ON public.transcript_spend_attempts TO transcript_spend_executor'); }
  });
});
