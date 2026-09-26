import { setImmediate } from 'node:timers';
import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('@/lib/transcript-spend', () => ({ transcriptEligibility: async () => ({
  allowed: true, tier: 'free', identifiers: ['user:one'],
}) }));
import { withInitialAnalysis } from '@/lib/initial-analysis-spend';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
