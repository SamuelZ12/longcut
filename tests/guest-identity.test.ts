import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ headers: new Headers(), token: undefined as string | undefined, usage: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => state.headers,
  cookies: async () => ({ get: (key: string) => key === 'tldw_guest_token' && state.token ? { value: state.token } : undefined }) }));
vi.mock('@/lib/limiter-store', () => ({ guestUsage: state.usage }));
import { getGuestAccessState } from '@/lib/guest-usage';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); state.token = undefined; });

it('uses only trusted Vercel IP, retaining identity when cookies and spoofable headers change', async () => {
  vi.stubEnv('VERCEL', '1');
  state.headers = new Headers({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2' });
  const first = await getGuestAccessState();
  state.headers.set('x-forwarded-for', '8.8.8.8');
  const second = await getGuestAccessState();
  expect(first.identifiers[1]).toBe(second.identifiers[1]);
  expect(first.token).not.toBe(second.token);
  expect(first.identifiers).toHaveLength(2);
});

it.each(['', '1.1.1.1, 2.2.2.2', 'spoofed', '[::1]:80', 'fe80::1%eth0'])('fails closed on untrusted or ambiguous IP: %s', async ip => {
  vi.stubEnv('VERCEL', '1');
  state.headers = new Headers({ 'x-vercel-forwarded-for': ip, 'x-forwarded-for': '1.1.1.1' });
  await expect(getGuestAccessState()).rejects.toThrow();
});

it('canonicalizes equivalent IPv6 addresses and rejects token-based identity forgery', async () => {
  vi.stubEnv('VERCEL', '1');
  state.token = 'ip:forged';
  state.headers = new Headers({ 'x-vercel-forwarded-for': '2001:0DB8:0:0:0:0:0:1' });
  const first = await getGuestAccessState();
  state.headers.set('x-vercel-forwarded-for', '2001:db8::1');
  const second = await getGuestAccessState();
  expect(first.identifiers[1]).toBe(second.identifiers[1]);
  expect(first.token).not.toBe('ip:forged');
  expect(first.tokenNeedsSet).toBe(true);
});

it('rejects arbitrary proxy headers in unsupported production hosting', async () => {
  vi.stubEnv('VERCEL', ''); vi.stubEnv('NODE_ENV', 'production');
  state.headers = new Headers({ 'x-forwarded-for': '1.1.1.1' });
  await expect(getGuestAccessState()).rejects.toThrow();
});
