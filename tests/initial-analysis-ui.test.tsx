// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIChat } from '@/components/ai-chat';
import { useTranslation } from '@/lib/hooks/use-translation';
import { requestAnalysisIntent, storeAnalysisIntent, takeAnalysisIntent } from '@/lib/initial-analysis-client';
import Home from '@/app/page';
import { toast } from 'sonner';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation, useSearchParams: () => navigation.search }));
vi.mock('@/lib/hooks/use-mode-preference', () => ({ useModePreference: () => ({ mode: 'fast', setMode: vi.fn() }) }));
vi.mock('@/components/url-input', () => ({ UrlInput: ({ onSubmit }: any) => <button onClick={() => onSubmit('https://www.youtube.com/watch?v=abcdefghijk')}>Submit video</button> }));
vi.mock('@/components/auth-modal', () => ({ AuthModal: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const paid = vi.fn();
const translation = vi.fn();
const requests: string[] = [];
const segments = [{ text: 'Useful insight.', start: 0, duration: 10 }];
function Workspace({ cached }: { cached?: string[] }) {
  const { selectedLanguage } = useTranslation();
  return <AIChat transcript={segments} topics={[]} videoId="abcdefghijk" videoTitle="Video"
    onCitationClick={() => {}} onTimestampClick={() => {}} cachedSuggestedQuestions={cached}
    selectedLanguage={selectedLanguage} onRequestTranslation={translation} />;
}
beforeEach(() => {
  vi.clearAllMocks(); requests.length = 0; sessionStorage.clear(); localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    if (url === '/api/image-limit') return Response.json({ remaining: 1 });
    if (url === '/api/csrf-token') return Response.json({}, { headers: { 'X-CSRF-Token': 'mock-token' } });
    if (url === '/api/analysis-intents') return Response.json({ flowId: '00000000-0000-4000-8000-000000000001' }, { status: 201 });
    // Any accidental standalone question request remains denied.
    if (url === '/api/suggested-questions') return Response.json({ error: 'Intent required' }, { status: 409 });
    paid(url); return Response.json({ summaryContent: 'Generated summary' });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([undefined, ['Cached question']])('passive chat mounts make zero paid calls, including translation/images/quotes (cached=%j)', async cached => {
  localStorage.setItem('selectedLanguage', 'es');
  const view = render(<Workspace cached={cached} />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  view.rerender(<Workspace cached={cached} />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(requests.every(url => url === '/api/image-limit')).toBe(true);
  expect(paid).not.toHaveBeenCalled(); expect(translation).not.toHaveBeenCalled();
});

it('explicit summary preset obtains server intent before its provider request', async () => {
  render(<Workspace />);
  fireEvent.click(await screen.findByRole('button', { name: /What are the key takeaways/ }));
  await waitFor(() => expect(paid).toHaveBeenCalledWith('/api/generate-summary'));
  expect(requests.indexOf('/api/analysis-intents')).toBeLessThan(requests.indexOf('/api/generate-summary'));
  const summary = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/generate-summary');
  expect(new Headers(summary?.[1]?.headers).get('x-analysis-flow')).toBe('00000000-0000-4000-8000-000000000001');
  await screen.findByText('Generated summary');
  expect(requests).not.toContain('/api/suggested-questions');
  expect(paid).toHaveBeenCalledTimes(1);
});

it.each([
  ['How can I apply this?', 'What are the limitations?'],
  undefined, null, ['Only one?'], ['Valid?', 42], ['Same?', ' same? '],
].map(followUpQuestions => ({ followUpQuestions })))('explicit chat consumes optional questions or falls back without another paid request ($followUpQuestions)', async ({ followUpQuestions }) => {
  const paidFetch = vi.fn(async () => Response.json({ content: 'An explicit chat answer.', citations: [], followUpQuestions }));
  render(<AIChat transcript={segments} topics={[]} videoId="abcdefghijk" paidFetch={paidFetch}
    onCitationClick={() => {}} onTimestampClick={() => {}} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Explain the insight' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
  await screen.findByText('An explicit chat answer.');
  await waitFor(() => {
    if (Array.isArray(followUpQuestions) && followUpQuestions[0] === 'How can I apply this?') {
      expect(screen.getByRole('button', { name: 'How can I apply this?' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'What are the limitations?' })).toBeTruthy();
    } else {
      expect(screen.getByRole('button', { name: 'What example clarifies the takeaway?' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'How can I apply this idea today?' })).toBeTruthy();
    }
  });
  expect(paidFetch).toHaveBeenCalledTimes(1);
  expect(paidFetch.mock.calls[0]).toEqual(expect.arrayContaining(['/api/chat']));
  expect(requests).not.toContain('/api/suggested-questions');
});

it('a generated follow-up click sends another explicit chat, not a standalone question request', async () => {
  const paidFetch = vi.fn(async () => Response.json({ content: 'Chat answer.',
    followUpQuestions: ['How can I apply this?', 'What are the limitations?'] }));
  render(<AIChat transcript={segments} topics={[]} videoId="abcdefghijk" paidFetch={paidFetch}
    onCitationClick={() => {}} onTimestampClick={() => {}} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Explain the insight' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
  fireEvent.click(await screen.findByRole('button', { name: 'How can I apply this?' }));
  await waitFor(() => expect(paidFetch).toHaveBeenCalledTimes(2));
  expect(paidFetch.mock.calls.every(call => (call as unknown[])[0] === '/api/chat')).toBe(true);
  const second = (paidFetch.mock.calls[1] as unknown[])[1] as RequestInit;
  expect(JSON.parse(String(second.body)).message).toBe('How can I apply this?');
  expect(requests).not.toContain('/api/suggested-questions');
});

it('quotes preset uses local follow-ups and makes only its existing paid request', async () => {
  const paidFetch = vi.fn(async () => Response.json({ quotesMarkdown: 'A memorable quote.' }));
  render(<AIChat transcript={segments} topics={[]} videoId="abcdefghijk" paidFetch={paidFetch}
    onCitationClick={() => {}} onTimestampClick={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /What are the juciest quotes/ }));
  await screen.findByText('A memorable quote.');
  expect(paidFetch).toHaveBeenCalledTimes(1);
  expect(paidFetch.mock.calls[0]).toEqual(expect.arrayContaining(['/api/top-quotes']));
  expect(requests).not.toContain('/api/suggested-questions');
});

it('submission handoff is bound to video and consumed once; failed admission stores no handoff', async () => {
  storeAnalysisIntent('abcdefghijk', await requestAnalysisIntent('abcdefghijk'));
  expect(takeAnalysisIntent('other123456')).toBeNull();
  expect(takeAnalysisIntent('abcdefghijk')).toBe('00000000-0000-4000-8000-000000000001');
  expect(takeAnalysisIntent('abcdefghijk')).toBeNull();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: 'Allowance unavailable' }, { status: 403 }));
  await expect(requestAnalysisIntent('abcdefghijk')).rejects.toThrow('Allowance unavailable');
  expect(takeAnalysisIntent('abcdefghijk')).toBeNull();
  expect(paid).not.toHaveBeenCalled();
});

it.each(['/api/check-video-cache', '/api/analysis-intents'])('home unmount cancels %s without handing off or navigating', async pendingUrl => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  vi.mocked(fetch).mockImplementation((input, options) => {
    if (String(input) === pendingUrl) {
      signal = options?.signal;
      return new Promise(resolve => { finish = resolve; });
    }
    if (String(input) === '/api/check-video-cache') return Promise.resolve(Response.json({ status: 'absent', cached: false }));
    return originalFetch(input, options);
  });
  const view = render(<Home />);
  fireEvent.click(screen.getByRole('button', { name: 'Submit video' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.unmount();
  await act(async () => { finish(Response.json(pendingUrl === '/api/check-video-cache' ? { status: 'absent', cached: false } : { flowId: 'flow' })); });
  expect(navigation.push).not.toHaveBeenCalled();
  expect(takeAnalysisIntent('abcdefghijk')).toBeNull();
  expect(signal?.aborted).toBe(true);
  if (pendingUrl === '/api/check-video-cache') expect(requests).not.toContain('/api/analysis-intents');
});

it('unmount during summary-preset admission prevents summary dispatch', async () => {
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
  const view = render(<Workspace />);
  fireEvent.click(await screen.findByRole('button', { name: /What are the key takeaways/ }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.unmount();
  await act(async () => { finish(Response.json({ flowId: 'flow' })); });
  expect(paid).not.toHaveBeenCalled();
  expect(signal?.aborted).toBe(true);
});

it('home deadline reports actionable timeout and allows a new deliberate submission', async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockImplementation((_input, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
  }));
  render(<Home />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit video' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(toast.error).toHaveBeenCalledWith('Starting analysis timed out. Please submit the video again.');
  expect(navigation.push).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValue(Response.json({ status: 'found', cached: true }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit video' })); });
  expect(navigation.push).toHaveBeenCalledTimes(1);
});

it('home supersession remains silent and late obsolete responses cannot navigate', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<Home />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit video' })); });
  vi.mocked(fetch).mockResolvedValue(Response.json({ status: 'found', cached: true }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit video' })); });
  await act(async () => { finish(Response.json({ status: 'found', cached: true })); });
  expect(navigation.push).toHaveBeenCalledTimes(1);
  expect(toast.error).not.toHaveBeenCalled();
});
