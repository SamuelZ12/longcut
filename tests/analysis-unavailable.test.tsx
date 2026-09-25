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
vi.mock('@/lib/csrf-client', () => ({ csrfFetch: { post: async () => {
  if (state.saveFails) throw new Error('connection refused');
  return Response.json({});
} } }));
vi.mock('@/components/right-column-tabs', () => ({ RightColumnTabs: () => <div>Transcript workspace</div> }));
vi.mock('@/components/youtube-player', () => ({ YouTubePlayer: () => null }));
vi.mock('@/components/highlights-panel', () => ({ HighlightsPanel: ({ onGenerateHighlights }: any) => <button onClick={onGenerateHighlights}>Generate highlights</button> }));
vi.mock('@/components/theme-selector', () => ({ ThemeSelector: () => null }));
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
    state.paid(url);
    if (url === '/api/transcript' && state.transcriptError) return Response.json(state.transcriptError.body, { status: state.transcriptError.status });
    return Response.json({ transcript, topics: [], summaryContent: 'Summary', preview: 'Preview' }, { status: state.paidStatus });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
  await screen.findByRole('heading', { name: 'Service temporarily unavailable' });
  expect(state.paid).not.toHaveBeenCalled();
  expect(Boolean(screen.queryByText('Transcript workspace'))).toBe(isCached);
});

it('real miss with healthy dependencies reaches transcript and AI', async () => {
  state.cacheStatus = 200;
  render(<AnalyzePage />);
  await waitFor(() => expect(state.paid).toHaveBeenCalledWith('/api/generate-summary'));
  expect(state.paid).toHaveBeenCalledWith('/api/transcript');
});

it('forced regeneration still requires preflight', async () => {
  state.search = new URLSearchParams('regen=1');
  state.limitStatus = 503;
  render(<AnalyzePage />);
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

it('persistence failure response suppresses follow-up questions and retry loops', async () => {
  state.cacheStatus = 200;
  state.cache = cached();
  state.paidStatus = 503;
  render(<AnalyzePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Generate highlights' }));
  await screen.findByRole('heading', { name: 'Service temporarily unavailable' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(state.paid.mock.calls).toEqual([['/api/video-analysis']]);
});

it('rejected post-provider persistence stops additional paid work, preserving transcript', async () => {
  state.cacheStatus = 200;
  state.cache = cached(null);
  state.saveFails = true;
  render(<AnalyzePage />);
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
