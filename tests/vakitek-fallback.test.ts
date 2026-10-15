import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const direct = vi.hoisted(() => vi.fn());
vi.mock('@/lib/transcript-cache', () => ({ assertTranscriptCacheOwner: async () => {}, reuseTranscript: vi.fn() }));
// This suite isolates native-provider ordering; initial intent is covered with real SQL in initial-analysis-db.
vi.mock('@/lib/initial-analysis-spend', () => ({ withInitialAnalysis: (_operation: unknown, handler: unknown) => handler }));
vi.mock('@/lib/security-middleware', () => ({ withSecurity: (handler: unknown) => handler, SECURITY_PRESETS: { PAID: {} } }));
vi.mock('@/lib/youtube-transcript-provider', () => ({ fetchYouTubeTranscript: direct }));
vi.mock('@/lib/mock-data', () => ({ shouldUseMockData: () => false }));
vi.mock('@/lib/transcript-spend', () => ({
  transcriptEligibility: async () => ({ allowed: true, tier: 'free', identifiers: ['user:test'] }),
  reserveTranscriptSpend: async () => ({ allowed: true, reservationId: 'test' }),
  transitionTranscriptSpend: async () => {},
}));
import { POST } from '@/app/api/transcript/route';
import { VAKITEK_TIMEOUT_MS } from '@/lib/vakitek-transcript-provider';

const upstream = vi.fn();
const request = () => new NextRequest('http://localhost/api/transcript', {
  method: 'POST', body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abcdefghijk', lang: 'en' }),
});
const host = (call: unknown[]) => new URL(call[0] as string).host;
const vakitekSuccess = () => Response.json({ data: [{ transcript: [{ text: 'Hi.', start: 0, dur: 1 }], language: 'en' }], billing: { events: { transcript: 1 } } });
const vakitekUnavailable = () => Response.json({ data: [{ error: 'NO_CAPTIONS', retryable: false, message: 'none' }] });
const vakitekDependencyFailure = () => Response.json({ error: 'internal' }, { status: 500 });
const supadataSuccess = () => Response.json({ content: [{ text: 'Hello.', offset: 120, duration: 250 }], lang: 'es' });

beforeEach(() => {
  vi.clearAllMocks();
  direct.mockResolvedValue(null);
  vi.stubGlobal('fetch', upstream);
  vi.stubEnv('VAKITEK_API_KEY', 'mock-vakitek-key');
  vi.stubEnv('SUPADATA_API_KEY', 'mock-supadata-key');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('tries Vakitek before Supadata and never calls Supadata on Vakitek success', async () => {
  upstream.mockResolvedValue(vakitekSuccess());
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: 'success', source: 'vakitek', transcript: [{ text: 'Hi.', start: 0, duration: 1 }] });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(host(upstream.mock.calls[0])).toBe('api.vakitek.co.uk');
});

it('does not call Supadata when Vakitek confirms captions are absent', async () => {
  upstream.mockResolvedValue(vakitekUnavailable());
  const response = await POST(request());
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ outcome: 'unavailable', source: 'vakitek', reason: 'no_captions' });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(host(upstream.mock.calls[0])).toBe('api.vakitek.co.uk');
});

it('falls through to Supadata when Vakitek reports a dependency failure', async () => {
  upstream.mockImplementation((url: string) => Promise.resolve(
    new URL(url).host === 'api.vakitek.co.uk' ? vakitekDependencyFailure() : supadataSuccess()
  ));
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: 'success', source: 'supadata', transcript: [{ text: 'Hello.', start: 0.12, duration: 0.25 }] });
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(host(upstream.mock.calls[0])).toBe('api.vakitek.co.uk');
  expect(host(upstream.mock.calls[1])).toBe('api.supadata.ai');
});

it('does not call Supadata after a Vakitek timeout, returning the shared unknown_upstream_acceptance response', async () => {
  vi.useFakeTimers();
  upstream.mockImplementation((url: string) =>
    new URL(url).host === 'api.vakitek.co.uk' ? new Promise(() => {}) : Promise.resolve(supadataSuccess()));
  const pending = POST(request());
  await vi.advanceTimersByTimeAsync(VAKITEK_TIMEOUT_MS);
  const response = await pending;
  expect(response.status).toBe(504);
  expect(await response.json()).toMatchObject({ outcome: 'unknown_upstream_acceptance', source: 'vakitek', reason: 'timeout',
    error: 'The transcript request did not complete. The provider may have accepted work; Longcut will not automatically resubmit this request.' });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(host(upstream.mock.calls[0])).toBe('api.vakitek.co.uk');
});

it('leaves behavior unchanged when VAKITEK_API_KEY is not configured', async () => {
  vi.stubEnv('VAKITEK_API_KEY', '');
  upstream.mockResolvedValue(supadataSuccess());
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: 'success', source: 'supadata' });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(host(upstream.mock.calls[0])).toBe('api.supadata.ai');
});

it('keeps direct success free of Vakitek calls', async () => {
  direct.mockResolvedValue({ segments: [{ text: 'Hello.', start: 0, duration: 2 }], language: 'en' });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(upstream).not.toHaveBeenCalled();
});
