import { setImmediate } from 'node:timers';
import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('@/lib/transcript-spend', () => ({ transcriptEligibility: async () => ({
  allowed: true, tier: 'free', identifiers: ['user:one'],
}) }));
import { createInitialAnalysisFlow, withInitialAnalysis } from '@/lib/initial-analysis-spend';
import { initialAIAttempt } from '@/lib/initial-ai-context';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const flowId = '00000000-0000-4000-8000-000000000001';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

it('flow creation without caller signal still has a bounded server RPC deadline', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let signal!: AbortSignal;
  mocks.rpc.mockImplementation(() => ({ abortSignal: (value: AbortSignal) => {
    signal = value;
    return new Promise(() => {});
  } }));
  const result = createInitialAnalysisFlow('abcdefghijk').catch(error => error);
  await flush();
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect((await result).name).toBe('DependencyUnavailableError');
  expect(signal.aborted).toBe(true);
});

it.each(['claim_initial_analysis_operation', 'reserve_initial_ai_attempt', 'finish_initial_ai_attempt', 'finish_initial_analysis_operation'])(
  'stalled %s is bounded even when transport ignores abort', async stalled => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispatch = vi.fn(async () => 'ok');
    let signal!: AbortSignal;
    mocks.rpc.mockImplementation((name: string) => ({ abortSignal: (value: AbortSignal) => {
      if (name === stalled) { signal = value; return new Promise(() => {}); }
      return Promise.resolve({ data: name === 'reserve_initial_ai_attempt' ? { allowed: true, reservation_id: flowId } : true, error: null });
    } }));
    const route = withInitialAnalysis('summary', async () => {
      await initialAIAttempt(dispatch);
      return NextResponse.json({});
    });
    const result = route(new NextRequest('http://localhost/api/generate-summary', {
      method: 'POST', headers: { 'x-analysis-flow': flowId, 'x-analysis-video': 'abcdefghijk' }, body: '{}',
    }));
    await flush();
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).status).toBe(503);
    expect(signal.aborted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(stalled.startsWith('finish') ? 1 : 0);
  });

it.each(['claim_initial_analysis_operation', 'reserve_initial_ai_attempt'])(
  'caller cancellation during %s prevents late admission from dispatching', async stalled => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new AbortController();
    const dispatch = vi.fn(async () => 'ok');
    let finish!: (value: unknown) => void;
    mocks.rpc.mockImplementation((name: string) => ({ abortSignal: () => name === stalled
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ data: true, error: null }) }));
    const route = withInitialAnalysis('summary', async () => {
      await initialAIAttempt(dispatch); return NextResponse.json({});
    });
    const result = route(new NextRequest('http://localhost/api/generate-summary', {
      method: 'POST', signal: controller.signal,
      headers: { 'x-analysis-flow': flowId, 'x-analysis-video': 'abcdefghijk' }, body: '{}',
    }));
    await flush(); controller.abort();
    expect((await result).status).toBe(503);
    finish({ data: stalled.startsWith('reserve') ? { allowed: true, reservation_id: flowId } : true, error: null });
    await flush(); expect(dispatch).not.toHaveBeenCalled();
  });

it('caller cancellation after possible dispatch cannot cancel independently bounded finalization', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const controller = new AbortController();
  let finalizationSignal!: AbortSignal;
  mocks.rpc.mockImplementation((name: string) => ({ abortSignal: (signal: AbortSignal) => {
    if (name === 'finish_initial_ai_attempt') {
      finalizationSignal = signal; return new Promise(() => {});
    }
    return Promise.resolve({ data: name === 'reserve_initial_ai_attempt' ? { allowed: true, reservation_id: flowId } : true, error: null });
  } }));
  const route = withInitialAnalysis('summary', async () => {
    await initialAIAttempt(async () => { controller.abort(); throw new Error('unknown acceptance'); });
    return NextResponse.json({});
  });
  const result = route(new NextRequest('http://localhost/api/generate-summary', {
    method: 'POST', signal: controller.signal,
    headers: { 'x-analysis-flow': flowId, 'x-analysis-video': 'abcdefghijk' }, body: '{}',
  }));
  await flush();
  expect(finalizationSignal.aborted).toBe(false);
  expect(mocks.rpc).toHaveBeenCalledWith('finish_initial_ai_attempt', { p_id: flowId, p_uncertain: true });
  await vi.advanceTimersByTimeAsync(5000);
  expect((await result).status).toBe(503);
  expect(finalizationSignal.aborted).toBe(true);
  expect(mocks.rpc).toHaveBeenCalledWith('finish_initial_analysis_operation', { p_flow: flowId, p_operation: 'summary' });
});

it.each(['deadline', 'cancellation'])('stalled flow validation stops on %s before cache election or acquisition', async cause => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let transportSignal: AbortSignal | undefined;
  let finish!: (value: { data: boolean; error: null }) => void;
  const pending = new Promise<{ data: boolean; error: null }>(resolve => { finish = resolve; });
  mocks.rpc.mockImplementation(() => ({ abortSignal: (signal: AbortSignal) => {
    transportSignal = signal;
    return pending; // Simulate transport/body that ignores abort and completes late.
  } }));
  const fresh = vi.fn(async () => NextResponse.json({}));
  const reuse = vi.fn(async (_request: NextRequest, acquire: () => Promise<NextResponse>) => acquire());
  const route = withInitialAnalysis('transcript', fresh, { reuse });
  const controller = new AbortController();
  const result = route(new NextRequest('http://localhost/api/transcript', {
    method: 'POST', signal: controller.signal,
    headers: { 'x-analysis-flow': '00000000-0000-4000-8000-000000000001' },
    body: JSON.stringify({ url: 'https://youtu.be/abcdefghijk' }),
  }));
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(transportSignal).toBeDefined();
  if (cause === 'cancellation') controller.abort();
  else await vi.advanceTimersByTimeAsync(5000);
  expect((await result).status).toBe(503);
  expect(transportSignal!.aborted).toBe(true);
  finish({ data: true, error: null });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(reuse).not.toHaveBeenCalled();
  expect(fresh).not.toHaveBeenCalled();
});
