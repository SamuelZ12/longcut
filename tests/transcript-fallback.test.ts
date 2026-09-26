import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const direct = vi.hoisted(() => vi.fn());
vi.mock('@/lib/transcript-cache', () => ({ assertTranscriptCacheOwner: async () => {}, reuseTranscript: vi.fn() }));
// This suite isolates native-provider outcomes; initial intent is covered with real SQL in initial-analysis-db.
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
import { SUPADATA_TIMEOUT_MS } from '@/lib/supadata-transcript-provider';

const upstream = vi.fn();
const request = () => new NextRequest('http://localhost/api/transcript', {
  method: 'POST', body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abcdefghijk', lang: 'en' }),
});
beforeEach(() => {
  vi.clearAllMocks();
  direct.mockResolvedValue(null);
  vi.stubGlobal('fetch', upstream);
  vi.stubEnv('SUPADATA_API_KEY', 'mock-secret');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each([
  [206, { error: 'transcript-unavailable' }, 404, 'unavailable'],
  [500, { error: 'internal-error' }, 502, 'dependency_failure'],
  [202, { jobId: 'private-job' }, 502, 'unknown_upstream_acceptance'],
  [200, { content: [] }, 404, 'unavailable'],
  [200, { content: [{ text: 'Missing timing' }] }, 502, 'dependency_failure'],
])('exposes accurate failure for upstream HTTP %s, scoped to Longcut allowance', async (status, body, expectedStatus, outcome) => {
  upstream.mockResolvedValue(Response.json(body, { status, headers: { 'x-billable-requests': '1' } }));
  const response = await POST(request());
  expect(response.status).toBe(expectedStatus);
  expect(await response.json()).toMatchObject({
    outcome, source: 'supadata', noCreditsUsed: true, creditsScope: 'longcut_allowance',
    creditsMessage: 'No Longcut video allowance was used. This does not indicate whether the transcript provider charged Longcut.',
    requestId: response.headers.get('x-request-id'),
  });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(new URL(upstream.mock.calls[0][0]).searchParams.get('mode')).toBe('native');
});

it('returns native success and ties API correlation to vendor telemetry', async () => {
  upstream.mockResolvedValue(Response.json({ content: [{ text: 'Hello.', offset: 120, duration: 250 }], lang: 'es' }));
  const response = await POST(request());
  const requestId = response.headers.get('x-request-id');
  expect(requestId).toEqual(expect.any(String));
  expect(await response.json()).toMatchObject({ outcome: 'success', source: 'supadata', requestId,
    transcript: [{ text: 'Hello.', start: 0.12, duration: 0.25 }], language: 'es' });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream.mock.calls[0][1].headers['x-request-id']).toBe(requestId);
  const events = vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(String(line)));
  expect(events).toHaveLength(2);
  expect(events.every(event => event.requestId === requestId)).toBe(true);
});

it('reports timeout as unknown acceptance rather than missing captions', async () => {
  vi.useFakeTimers();
  upstream.mockImplementation(() => new Promise(() => {}));
  const pending = POST(request());
  await vi.advanceTimersByTimeAsync(SUPADATA_TIMEOUT_MS);
  const response = await pending;
  expect(response.status).toBe(504);
  expect(await response.json()).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'timeout', retryable: false });
  expect(upstream).toHaveBeenCalledTimes(1);
});

it('does not label unconfigured fallback as missing captions', async () => {
  vi.stubEnv('SUPADATA_API_KEY', '');
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ outcome: 'dependency_failure' });
  expect(upstream).not.toHaveBeenCalled();
});

it('keeps direct success free of Supadata calls', async () => {
  direct.mockResolvedValue({ segments: [{ text: 'Hello.', start: 0, duration: 2 }], language: 'en' });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(upstream).not.toHaveBeenCalled();
});
