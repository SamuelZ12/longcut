import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchSupadataTranscript, SUPADATA_TIMEOUT_MS, supadataNativeCacheIdentity } from '@/lib/supadata-transcript-provider';

const upstream = vi.fn();
const input = { videoId: 'abcdefghijk', apiKey: 'secret-test-key', requestId: 'test-request' };
const nativeBody = {
  content: [
    { text: '>> Early caption.', offset: 120, duration: 250 },
    { text: 'Later caption.', offset: 8150, duration: 1200 },
  ],
  lang: 'es', availableLangs: ['es'],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', upstream);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function expectOneNativeCall() {
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(new URL(upstream.mock.calls[0][0]).searchParams.get('mode')).toBe('native');
}

function completion() {
  return vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(String(line)))
    .find(event => event.event === 'supadata_transcript_completed');
}

it('fetches native captions once and converts documented millisecond units, including small offsets', async () => {
  upstream.mockResolvedValue(Response.json(nativeBody, { headers: { 'x-billable-requests': '1' } }));
  const result = await fetchSupadataTranscript({ ...input, lang: 'en' });
  expect(result).toMatchObject({
    outcome: 'success', language: 'es', availableLanguages: ['es'],
    segments: [
      { text: 'Early caption.', start: 0.12, duration: 0.25 },
      { text: 'Later caption.', start: 8.15, duration: 1.2 },
    ],
    metadata: { source: 'supadata', mode: 'native', upstreamStatus: 200, billableCredits: 1, billingKind: 'reported', requestId: 'test-request' },
  });
  expect(upstream).toHaveBeenCalledTimes(1);
  const [url, options] = upstream.mock.calls[0];
  expect(new URL(url).searchParams.get('mode')).toBe('native');
  expect(new URL(url).searchParams.get('text')).toBe('false');
  expect(new URL(url).searchParams.get('lang')).toBe('en');
  expect(options).toMatchObject({ redirect: 'error', cache: 'no-store', headers: { 'x-request-id': 'test-request' } });
});

it.each([
  [206, { error: 'transcript-unavailable' }, 'unavailable', 'captions_unavailable'],
  [206, nativeBody, 'unavailable', 'captions_unavailable'],
  [200, { content: [] }, 'unavailable', 'empty_content'],
  [500, { error: 'internal-error', details: 'sensitive upstream detail' }, 'dependency_failure', 'upstream_failure'],
  [429, {}, 'dependency_failure', 'upstream_failure'],
  [404, {}, 'dependency_failure', 'upstream_failure'],
  [202, { jobId: 'private-job-id' }, 'unknown_upstream_acceptance', 'unexpected_job'],
  [200, { jobId: 'private-job-id', ...nativeBody }, 'unknown_upstream_acceptance', 'unexpected_job'],
])('classifies HTTP %s intentionally, keeping billed failures visible', async (status, body, outcome, reason) => {
  upstream.mockResolvedValue(Response.json(body, { status, headers: { 'x-billable-requests': '3' } }));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome, reason, metadata: { upstreamStatus: status, billableCredits: 3 } });
  expectOneNativeCall();
  expect(completion()).toMatchObject({ outcome, reason, billableCredits: 3, requestId: input.requestId, latencyMs: expect.any(Number) });
  const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
  for (const secret of [input.apiKey, 'private-job-id', 'sensitive upstream detail', 'Early caption.']) expect(logs).not.toContain(secret);
  if (reason === 'unexpected_job') expect(completion()).toMatchObject({ billingKind: 'precharge_estimate', jobIdHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

it.each([null, {}, { content: 'plain text' }, { transcript: nativeBody.content },
  { content: [null] }, { content: [{ text: 'hello', offset: '120', duration: 250 }] },
  { content: [{ text: 'hello', offset: -1, duration: 250 }] },
  { content: [{ text: 'hello', offset: 1 }] },
  { content: [{ text: '  >> ', offset: 0, duration: 10 }] },
])('rejects malformed content without retry: %j', async body => {
  upstream.mockResolvedValue(Response.json(body));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'dependency_failure', reason: 'malformed_content' });
  expectOneNativeCall();
});

it.each([200, 202])('handles invalid JSON for HTTP %s without losing billing metadata', async status => {
  upstream.mockResolvedValue(new Response('not json secret', { status, headers: { 'x-billable-requests': '1' } }));
  expect(await fetchSupadataTranscript(input)).toMatchObject({
    outcome: status === 202 ? 'unknown_upstream_acceptance' : 'dependency_failure',
    metadata: { billableCredits: 1, upstreamStatus: status },
  });
  expectOneNativeCall();
});

it.each([null, '', '-1', 'NaN', 'Infinity', 'garbage', '0', '2.5'])('records billing header %j without inferring zero', async header => {
  upstream.mockResolvedValue(Response.json(nativeBody, { headers: header === null ? {} : { 'x-billable-requests': header } }));
  const known = header === '0' || header === '2.5';
  expect(await fetchSupadataTranscript(input)).toMatchObject({ metadata: {
    billableCredits: known ? Number(header) : null, billingKind: known ? 'reported' : 'unknown',
  } });
  expectOneNativeCall();
});

it.each(['headers', 'body'])('bounds waiting for stalled %s, aborts locally, and never resubmits', async phase => {
  vi.useFakeTimers();
  upstream.mockImplementation(() => phase === 'headers' ? new Promise(() => {}) : Promise.resolve({
    status: 200, headers: new Headers({ 'x-billable-requests': '1' }), json: () => new Promise(() => {}),
  }));
  const pending = fetchSupadataTranscript(input);
  await vi.advanceTimersByTimeAsync(SUPADATA_TIMEOUT_MS);
  expect(await pending).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'timeout', metadata: {
    upstreamStatus: phase === 'headers' ? null : 200, billableCredits: phase === 'headers' ? null : 1,
    latencyMs: SUPADATA_TIMEOUT_MS,
  } });
  expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
  expectOneNativeCall();
  expect(vi.getTimerCount()).toBe(0);
});

it('treats transport failures as unknown acceptance and redacts thrown details', async () => {
  upstream.mockRejectedValue(new Error('secret-test-key cookie=secret'));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'network_failure' });
  expectOneNativeCall();
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('secret');
});

it('cancels in-flight waiting without starting another request', async () => {
  const controller = new AbortController();
  upstream.mockImplementation(() => new Promise(() => {}));
  const pending = fetchSupadataTranscript({ ...input, signal: controller.signal });
  controller.abort();
  expect(await pending).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'cancelled' });
  expectOneNativeCall();
});

it('does not submit already-cancelled requests', async () => {
  expect(await fetchSupadataTranscript({ ...input, signal: AbortSignal.abort() })).toMatchObject({ outcome: 'dependency_failure', reason: 'cancelled' });
  expect(upstream).not.toHaveBeenCalled();
});

it('publishes native-mode cache identity with requested language isolation', () => {
  expect(supadataNativeCacheIdentity(input.videoId, 'en')).toBe('["supadata","native","v1","abcdefghijk","en"]');
  expect(supadataNativeCacheIdentity(input.videoId)).toBe('["supadata","native","v1","abcdefghijk",null]');
  expect(supadataNativeCacheIdentity(input.videoId, 'es')).not.toBe(supadataNativeCacheIdentity(input.videoId, 'en'));
});
