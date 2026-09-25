import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
// Isolate ticket03 vendor accounting; ticket04's real intent boundary has its own DB suite.
vi.mock('@/lib/initial-analysis-spend', () => ({ withInitialAnalysis: (_operation: unknown, handler: unknown) => handler }));

const state = vi.hoisted(() => ({
  user: { id: '00000000-0000-4000-8000-000000000001' } as any,
  allowed: true, tier: 'free', topup: 0, unlimited: false, guestUsed: false,
  reserve: { allowed: false, reason: 'budget', retry_at: '2030-01-01T00:00:00Z' } as any,
  rpc: vi.fn(), direct: vi.fn(), upstream: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/security-middleware', () => ({ withSecurity: (h: unknown) => h, SECURITY_PRESETS: { PAID: {} } }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
}) }));
vi.mock('@/lib/subscription-manager', () => ({ canGenerateVideo: async () => ({
  allowed: state.allowed, reason: 'LIMIT_REACHED', subscription: { tier: state.tier, topupCredits: state.topup },
}) }));
vi.mock('@/lib/access-control', () => ({ hasUnlimitedVideoAllowance: () => state.unlimited }));
vi.mock('@/lib/guest-usage', () => ({ getGuestAccessState: async () => ({
  used: state.guestUsed, identifiers: ['guest-token', 'ip:trusted'], token: 'guest-token', tokenNeedsSet: true,
}), setGuestCookies: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => ({ rpc: state.rpc }) }));
vi.mock('@/lib/youtube-transcript-provider', () => ({ fetchYouTubeTranscript: state.direct }));
vi.mock('@/lib/mock-data', () => ({ shouldUseMockData: () => false }));
import { POST } from '@/app/api/transcript/route';

export const request = (query = '', body = {}) => new NextRequest(`http://localhost/api/transcript${query}`, {
  method: 'POST', body: JSON.stringify({ url: 'https://youtube.com/watch?v=abcdefghijk', ...body }),
});
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { user: { id: '00000000-0000-4000-8000-000000000001' }, allowed: true,
    tier: 'free', topup: 0, unlimited: false, guestUsed: false,
    reserve: { allowed: false, reason: 'budget', retry_at: '2030-01-01T00:00:00Z' } });
  state.rpc.mockImplementation(async (name: string) => ({ data: name === 'reserve_transcript_spend' ? state.reserve : true, error: null }));
  state.direct.mockResolvedValue(null);
  state.upstream.mockResolvedValue(Response.json({ content: [{ text: 'Hello.', offset: 0, duration: 1000 }] }));
  vi.stubGlobal('fetch', state.upstream);
  vi.stubEnv('SUPADATA_API_KEY', 'mock');
  vi.stubEnv('SUPADATA_SPEND_POLICY', 'native-v1');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('denies exhausted vendor allowance before dispatch without charging customer credit', async () => {
  const response = await POST(request('?nonce=forged', { userId: 'forged', tier: 'unlimited', limit: 999 }));
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({ code: 'TRANSCRIPT_SPEND_THROTTLED', noCreditsUsed: true, resetAt: '2030-01-01T00:00:00Z' });
  expect(state.upstream).not.toHaveBeenCalled();
  expect(state.rpc).toHaveBeenCalledWith('reserve_transcript_spend', expect.objectContaining({
    p_tier: 'free', p_identifiers: ['user:00000000-0000-4000-8000-000000000001'],
  }));
});

it.each([
  ['free', 0, false, 'free'], ['free', 5, false, 'topup'], ['pro', 0, false, 'pro'],
  ['pro', 5, false, 'pro'], ['pro', 5, true, 'unlimited'],
])('derives one non-additive tier from trusted eligibility: %s/%s/%s', async (tier, topup, unlimited, expected) => {
  Object.assign(state, { tier, topup, unlimited, reserve: { allowed: true, reservation_id: 'reservation' } });
  const response = await POST(request('?tier=unlimited', { lang: 'EN-us' }));
  expect(response.status).toBe(200);
  expect(state.upstream).toHaveBeenCalledTimes(1);
  expect(state.rpc).toHaveBeenCalledWith('reserve_transcript_spend', expect.objectContaining({ p_tier: expected,
    p_key: '["supadata","native","v1","abcdefghijk","en-us"]' }));
  expect(state.rpc.mock.calls.map(([name]) => name)).toEqual(['reserve_transcript_spend', 'transition_transcript_spend', 'transition_transcript_spend']);
});

it.each([false, true])('checks customer eligibility before any upstream call (guest=%s)', async guest => {
  if (guest) { state.user = null; state.guestUsed = true; } else state.allowed = false;
  expect((await POST(request())).status).toBe(guest ? 401 : 403);
  expect(state.direct).not.toHaveBeenCalled();
  expect(state.upstream).not.toHaveBeenCalled();
  expect(state.rpc).not.toHaveBeenCalled();
});

it('admits eligible guests without consuming their one-time analysis allowance', async () => {
  state.user = null;
  state.reserve = { allowed: true, reservation_id: 'reservation' };
  expect((await POST(request())).status).toBe(200);
  expect(state.rpc).toHaveBeenCalledWith('reserve_transcript_spend', expect.objectContaining({ p_tier: 'guest', p_identifiers: ['guest-token', 'ip:trusted'] }));
  expect(state.rpc.mock.calls.some(([name]) => /credit|guest_usage/.test(name))).toBe(false);
});

it('direct YouTube success remains free even when paid policy is disabled', async () => {
  vi.stubEnv('SUPADATA_SPEND_POLICY', '');
  state.direct.mockResolvedValue({ segments: [{ text: 'Hello.', start: 0, duration: 2 }] });
  expect((await POST(request())).status).toBe(200);
  expect(state.rpc).not.toHaveBeenCalled();
  expect(state.upstream).not.toHaveBeenCalled();
});

it('preserves provider language casing while canonicalizing only spend identity', async () => {
  state.direct.mockResolvedValue({ segments: [{ text: 'Hello.', start: 0, duration: 2 }] });
  expect((await POST(request('', { lang: 'en-US' }))).status).toBe(200);
  expect(state.direct).toHaveBeenCalledWith('abcdefghijk', 'en-US', undefined);
  expect(state.upstream).not.toHaveBeenCalled();
});

it('releases only demonstrably pre-dispatch cancellation', async () => {
  state.reserve = { allowed: true, reservation_id: 'reservation' };
  const controller = new AbortController(); controller.abort();
  const req = new NextRequest(request(), { signal: controller.signal });
  expect((await POST(req)).status).toBe(503);
  expect(state.upstream).not.toHaveBeenCalled();
  expect(state.rpc).toHaveBeenCalledWith('transition_transcript_spend', { p_id: 'reservation', p_action: 'release' });
});

it.each([206, 500, 202])('retains unit after upstream HTTP %s with no automatic retries', async status => {
  state.reserve = { allowed: true, reservation_id: 'reservation' };
  state.upstream.mockResolvedValue(Response.json(status === 202 ? { jobId: 'job' } : {}, { status }));
  await POST(request());
  expect(state.upstream).toHaveBeenCalledTimes(1);
  expect(state.rpc).toHaveBeenLastCalledWith('transition_transcript_spend', {
    p_id: 'reservation', p_action: status === 202 ? 'uncertain' : 'complete',
  });
  expect(state.rpc.mock.calls.some(([, args]) => args.p_action === 'release')).toBe(false);
});

it('retains uncertain network attempts and makes explicit retry request another reservation', async () => {
  state.reserve = { allowed: true, reservation_id: 'reservation' };
  state.upstream.mockRejectedValue(new Error('connection lost'));
  await POST(request());
  expect(state.rpc).toHaveBeenLastCalledWith('transition_transcript_spend', { p_id: 'reservation', p_action: 'uncertain' });
  state.reserve = { allowed: false, reason: 'cooldown', retry_at: '2030-01-01T00:00:00Z' };
  expect((await POST(request('?refresh=1', { refresh: true }))).status).toBe(429);
  expect(state.upstream).toHaveBeenCalledTimes(1);
  expect(state.rpc.mock.calls.filter(([name]) => name === 'reserve_transcript_spend')).toHaveLength(2);
});
