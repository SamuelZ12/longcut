// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  cacheStatus: 503, limitStatus: 200, paidStatus: 200, cache: null as any,
  failNetwork: false, requests: [] as string[], paid: vi.fn(),
  saveFails: false, transcriptError: null as any,
  search: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ videoId: 'abcdefghijk' }), useSearchParams: () => state.search,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/lib/hooks/use-mode-preference', () => ({ useModePreference: () => ({ mode: 'fast', isLoading: false }) }));
vi.mock('@/lib/hooks/use-translation', () => ({ useTranslation: () => ({ translationCache: new Map(), handleLanguageChange: () => {} }) }));
vi.mock('@/lib/hooks/use-subscription', () => ({ useSubscription: () => ({}) }));
vi.mock('@/lib/hooks/use-transcript-export', () => ({ useTranscriptExport: () => ({}) }));
vi.mock('@/lib/notes-client', () => ({ fetchNotes: async () => [], saveNote: vi.fn() }));
vi.mock('@/lib/csrf-client', () => ({ csrfFetch: { post: async (url: string, _body: unknown, options?: RequestInit) => {
  if (url === '/api/analysis-intents') return fetch(url, { ...options, method: 'POST' });
  if (state.saveFails) throw new Error('connection refused');
  return Response.json({});
} } }));
vi.mock('@/components/right-column-tabs', () => ({ RightColumnTabs: () => <div>Transcript workspace</div> }));
vi.mock('@/components/youtube-player', () => ({ YouTubePlayer: () => null }));
vi.mock('@/components/highlights-panel', () => ({ HighlightsPanel: ({ onGenerateHighlights }: any) => <button onClick={onGenerateHighlights}>Generate highlights</button> }));
vi.mock('@/components/theme-selector', () => ({ ThemeSelector: ({ onSelect }: any) => <>
  <button onClick={() => onSelect('First theme')}>First theme</button>
  <button onClick={() => onSelect('Second theme')}>Second theme</button>
</> }));
vi.mock('@/components/loading-context', () => ({ LoadingContext: () => null }));
vi.mock('@/components/loading-tips', () => ({ LoadingTips: () => null }));
vi.mock('@/components/video-skeleton', () => ({ VideoSkeleton: () => null }));
vi.mock('@/components/auth-modal', () => ({ AuthModal: () => null }));
vi.mock('@/components/transcript-export-dialog', () => ({ TranscriptExportDialog: () => null }));
vi.mock('@/components/transcript-export-upsell', () => ({ TranscriptExportUpsell: () => null }));
vi.mock('@/components/selection-actions', () => ({ EXPLAIN_SELECTION_EVENT: 'explain-selection' }));

import AnalyzePage from '@/app/analyze/[videoId]/page';

const transcript = [{ text: 'First sentence.', start: 0, duration: 5 }, { text: 'Second sentence.', start: 5, duration: 5 }];
const cached = (summary: string | null = 'Existing summary') => ({
  status: 'found', cached: true, transcript, topics: [], summary,
  videoInfo: { title: 'Test video', duration: 10 },
});
beforeEach(() => {
  Object.assign(state, { cacheStatus: 503, limitStatus: 200, paidStatus: 200,
    cache: null, failNetwork: false, saveFails: false, transcriptError: null, requests: [], search: new URLSearchParams() });
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    state.requests.push(url);
    if (url === '/api/check-video-cache') {
      if (state.failNetwork) throw new Error('connection refused');
      return Response.json(state.cache ?? { status: 'absent', cached: false }, { status: state.cacheStatus });
    }
    if (url === '/api/check-limit') return Response.json({ canGenerate: true }, { status: state.limitStatus });
    if (url === '/api/video-info') return Response.json({ title: 'Test video', duration: 10 });
    if (url === '/api/analysis-intents') return Response.json({ flowId: '00000000-0000-4000-8000-000000000001' });
    state.paid(url);
    if (url === '/api/transcript' && state.transcriptError) return Response.json(state.transcriptError.body, { status: state.transcriptError.status });
    return Response.json({ transcript, topics: [], summaryContent: 'Summary', preview: 'Preview' }, { status: url === '/api/suggested-questions' ? 200 : state.paidStatus });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([402, 403, 500, 503])('cache HTTP %s stops automatic generation; retry is explicit', async status => {
  state.cacheStatus = status;
  const view = render(<AnalyzePage />);
  await screen.findByRole('heading', { name: 'Service temporarily unavailable' });
  expect(state.paid).not.toHaveBeenCalled();
  const cacheCalls = state.requests.filter(url => url === '/api/check-video-cache').length;
  view.rerender(<AnalyzePage />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(state.requests.filter(url => url === '/api/check-video-cache')).toHaveLength(cacheCalls);
  expect(state.paid).not.toHaveBeenCalled();
  state.cacheStatus = 200;
  state.cache = cached();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('Transcript workspace');
  expect(state.paid).not.toHaveBeenCalled();
});

it('network cache failure shows recoverable service state', async () => {
  state.failNetwork = true;
  render(<AnalyzePage />);
  await screen.findByRole('heading', { name: 'Service temporarily unavailable' });
  expect(state.paid).not.toHaveBeenCalled();
});

it.each([false, true])('required preflight failure stops missing content (cached=%s)', async isCached => {
  state.cacheStatus = 200;
  state.cache = isCached ? cached(null) : null;
  state.limitStatus = 503;
  render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: isCached ? 'Generate missing summary' : 'Analyze video' }));
  await screen.findByRole('heading', { name: 'Service temporarily unavailable' });
  expect(state.paid).not.toHaveBeenCalled();
  expect(Boolean(screen.queryByText('Transcript workspace'))).toBe(isCached);
});

it('real miss stays passive; deliberate action reaches transcript and AI', async () => {
  state.cacheStatus = 200;
  render(<AnalyzePage />);
  const start = await screen.findByRole('button', { name: 'Analyze video' });
  expect(state.paid).not.toHaveBeenCalled();
  fireEvent.click(start);
  await waitFor(() => expect(state.paid).toHaveBeenCalledWith('/api/generate-summary'));
  expect(state.paid).toHaveBeenCalledWith('/api/transcript');
});

it('cached missing summary stays public and passive until explicitly requested', async () => {
  state.cacheStatus = 200; state.cache = cached(null);
  render(<AnalyzePage />);
  await screen.findByText('Transcript workspace');
  const start = await screen.findByRole('button', { name: 'Generate missing summary' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(state.paid).not.toHaveBeenCalled();
  fireEvent.click(start);
  await waitFor(() => expect(state.paid.mock.calls).toEqual([['/api/generate-summary']]));
});

it('one-shot server intent from explicit URL submission continues without a second click', async () => {
  state.cacheStatus = 200;
  sessionStorage.setItem('analysis-intent:abcdefghijk', '00000000-0000-4000-8000-000000000001');
  render(<AnalyzePage />);
  await waitFor(() => expect(state.paid).toHaveBeenCalledWith('/api/generate-summary'));
  expect(state.requests).not.toContain('/api/analysis-intents');
  expect(sessionStorage.getItem('analysis-intent:abcdefghijk')).toBeNull();
});

it('forced regeneration still requires preflight', async () => {
  state.search = new URLSearchParams('regen=1');
  state.limitStatus = 503;
  render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Analyze video' }));
  await screen.findByRole('heading', { name: 'Service temporarily unavailable' });
  expect(state.paid).not.toHaveBeenCalled();
});

it('explicit highlight generation can proceed from a healthy cache hit', async () => {
  state.cacheStatus = 200;
  state.cache = cached();
  render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Generate highlights' }));
  // Cached topic list is empty, so this goes through the real generation path.
  await waitFor(() => expect(state.paid).toHaveBeenCalledWith('/api/video-analysis'));
});

it('revealing existing cached highlights never generates missing questions', async () => {
  state.cacheStatus = 200;
  state.cache = { ...cached(), topics: [{ id: 'cached', title: 'Cached topic', segments: [], duration: 0 }] };
  render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Generate highlights' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(state.paid).not.toHaveBeenCalled();
  expect(state.requests).not.toContain('/api/analysis-intents');
});

it('missing-summary intent does not leak into successive explicit cached theme requests', async () => {
  state.cacheStatus = 200;
  state.cache = { ...cached(null), topics: [{ id: 'cached', title: 'Cached topic', segments: [], duration: 0 }], themes: ['First theme', 'Second theme'] };
  render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Generate missing summary' }));
  await waitFor(() => expect(state.paid).toHaveBeenCalledWith('/api/generate-summary'));
  fireEvent.click(await screen.findByRole('button', { name: 'Generate highlights' }));
  for (const theme of ['First theme', 'Second theme']) {
    fireEvent.click(await screen.findByRole('button', { name: theme }));
    await waitFor(() => {
      const request = vi.mocked(fetch).mock.calls.find(([url, options]) => url === '/api/video-analysis' && JSON.parse(String(options?.body)).theme === theme);
      expect(request).toBeTruthy();
      expect(new Headers(request?.[1]?.headers).has('x-analysis-flow')).toBe(false);
      expect(new Headers(request?.[1]?.headers).has('x-analysis-video')).toBe(false);
    });
  }
  expect(state.paid.mock.calls.filter(([url]) => url === '/api/video-analysis')).toHaveLength(2);
});

it('unmount during highlight admission cancels intent and prevents downstream paid calls', async () => {
  state.cacheStatus = 200; state.cache = cached();
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  let finishAdmission!: (response: Response) => void;
  let admissionSignal: AbortSignal | null | undefined;
  vi.mocked(fetch).mockImplementation((input, options) => {
    if (String(input) === '/api/analysis-intents') {
      admissionSignal = options?.signal;
      // Deliberately emulate a response that wins the abort race.
      return new Promise(resolve => { finishAdmission = resolve; });
    }
    return originalFetch(input, options);
  });
  const view = render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Generate highlights' }));
  await waitFor(() => expect(finishAdmission).toBeTypeOf('function'));
  view.unmount();
  await act(async () => { finishAdmission(Response.json({ flowId: '00000000-0000-4000-8000-000000000001' })); });
  expect(state.paid).not.toHaveBeenCalled();
  expect(admissionSignal?.aborted).toBe(true);
});

it('unmount during optional questions prevents the subsequent highlight dispatch', async () => {
  state.cacheStatus = 200; state.cache = cached();
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  vi.mocked(fetch).mockImplementation((input, options) => {
    if (String(input) === '/api/suggested-questions') {
      signal = options?.signal;
      return new Promise(resolve => { finish = resolve; });
    }
    return originalFetch(input, options);
  });
  const view = render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Generate highlights' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.unmount();
  await act(async () => { finish(Response.json({ questions: [] })); });
  expect(state.paid).not.toHaveBeenCalledWith('/api/video-analysis');
  expect(signal?.aborted).toBe(true);
});

it.each([false, true])('unmount during initial admission prevents missing-content dispatch (cached=%s)', async isCached => {
  state.cacheStatus = 200; state.cache = isCached ? cached(null) : null;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  vi.mocked(fetch).mockImplementation((input, options) => {
    if (String(input) === '/api/analysis-intents') {
      signal = options?.signal;
      return new Promise(resolve => { finish = resolve; });
    }
    return originalFetch(input, options);
  });
  const view = render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: isCached ? 'Generate missing summary' : 'Analyze video' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.unmount();
  await act(async () => { finish(Response.json({ flowId: 'flow' })); });
  expect(state.paid).not.toHaveBeenCalled();
  expect(signal?.aborted).toBe(true);
});

it.each(['timeout', 'unmount'])('late acquisition response after %s cannot start preview or summary', async cancellation => {
  vi.useFakeTimers();
  state.cacheStatus = 200;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (response: Response) => void;
  let acquisitionSignal: AbortSignal | null | undefined;
  vi.mocked(fetch).mockImplementation((input, options) => {
    if (String(input) === '/api/transcript') {
      acquisitionSignal = options?.signal;
      return new Promise(resolve => { finish = resolve; });
    }
    return originalFetch(input, options);
  });
  const view = render(<AnalyzePage />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Analyze video' })); });
  expect(finish).toBeTypeOf('function');
  if (cancellation === 'timeout') await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  else view.unmount();
  await act(async () => { finish(Response.json({ transcript })); });
  expect(state.paid).not.toHaveBeenCalledWith('/api/quick-preview');
  expect(state.paid).not.toHaveBeenCalledWith('/api/generate-summary');
  expect(acquisitionSignal?.aborted).toBe(true);
  if (cancellation === 'timeout') expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

it.each(['/api/check-video-cache', '/api/analysis-intents'])('initialization timeout at %s exposes deliberate retry', async pendingUrl => {
  vi.useFakeTimers(); state.cacheStatus = 200;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, options) => {
    if (String(input) === pendingUrl) return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    });
    return originalFetch(input, options);
  });
  render(<AnalyzePage />);
  await act(async () => {});
  if (pendingUrl === '/api/analysis-intents') await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Analyze video' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(screen.getByText(/Analysis initialization timed out/)).toBeTruthy();
  const retry = screen.getByRole('button', { name: 'Try again' });
  expect(state.paid).not.toHaveBeenCalled();
  vi.mocked(fetch).mockImplementation(originalFetch);
  await act(async () => { fireEvent.click(retry); });
  expect(state.paid).toHaveBeenCalledWith('/api/generate-summary');
});

it.each(['/api/transcript', '/api/video-info'])('deadline during %s body parsing prevents new AI dispatch', async pendingUrl => {
  vi.useFakeTimers(); state.cacheStatus = 200;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  let finishBody!: (body: unknown) => void;
  vi.mocked(fetch).mockImplementation((input, options) => {
    if (String(input) === pendingUrl) return Promise.resolve(Object.assign(Response.json({}), {
      json: () => new Promise(resolve => { finishBody = resolve; }),
    }));
    return originalFetch(input, options);
  });
  render(<AnalyzePage />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Analyze video' })); });
  expect(finishBody).toBeTypeOf('function');
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  await act(async () => { finishBody(pendingUrl === '/api/transcript' ? { transcript } : { title: 'Late metadata', duration: 10 }); });
  expect(state.paid).not.toHaveBeenCalledWith('/api/quick-preview');
  expect(state.paid).not.toHaveBeenCalledWith('/api/generate-summary');
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

it('persistence failure response suppresses follow-up questions and retry loops', async () => {
  state.cacheStatus = 200;
  state.cache = cached();
  state.paidStatus = 503;
  render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Generate highlights' }));
  await screen.findByRole('heading', { name: 'Service temporarily unavailable' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(state.paid.mock.calls).toEqual([['/api/suggested-questions'], ['/api/video-analysis']]);
});

it('rejected post-provider persistence stops additional paid work, preserving transcript', async () => {
  state.cacheStatus = 200;
  state.cache = cached(null);
  state.saveFails = true;
  render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Generate missing summary' }));
  await screen.findByRole('heading', { name: 'Service temporarily unavailable' });
  expect(screen.getByText('Transcript workspace')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Generate highlights' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(state.paid.mock.calls).toEqual([['/api/generate-summary']]);
});

it.each([
  [429, 'TRANSCRIPT_SPEND_THROTTLED', 'Fresh transcript requests paused'],
  [403, 'TRANSCRIPT_ELIGIBILITY_REQUIRED', 'Video allowance required'],
  [404, 'TRANSCRIPT_UNAVAILABLE', 'Captions unavailable'],
  [502, 'TRANSCRIPT_DEPENDENCY_FAILURE', 'Transcript service unavailable'],
  [504, 'TRANSCRIPT_UNKNOWN_UPSTREAM_ACCEPTANCE', 'Transcript request not confirmed'],
])('distinguishes transcript failure %s and retries only on explicit action', async (status, code, heading) => {
  state.cacheStatus = 200;
  state.transcriptError = { status, body: { code, error: 'Request could not finish.', noCreditsUsed: true,
    ...(status === 429 ? { resetAt: '2030-01-01T00:00:00Z' } : {}) } };
  const view = render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Analyze video' }));
  await screen.findByRole('heading', { name: heading });
  expect(screen.getByText(/No Longcut video allowance was used/)).toBeTruthy();
  if (status === 429) expect(screen.getByText(/Try again after/)).toBeTruthy();
  expect(state.paid.mock.calls).toEqual([['/api/transcript']]);
  view.rerender(<AnalyzePage />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(state.paid.mock.calls).toHaveLength(1);
  state.transcriptError = null;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(state.paid).toHaveBeenCalledWith('/api/generate-summary'));
});
