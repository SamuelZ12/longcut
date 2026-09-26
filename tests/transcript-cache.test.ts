import { setImmediate as realSetImmediate } from 'node:timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
// Node's promise timers bypass Vitest's clock. Preserve cancellable delay semantics
// while scheduling through the fakeable global timer; leave cache logic untouched.
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(value); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  }),
}));

import { assertTranscriptCacheOwner, reuseTranscript } from '@/lib/transcript-cache';

type RpcResult = { data: unknown; error: unknown };
type Plan = { data?: unknown; error?: unknown; delay?: number };
type Call = { name: string; args: Record<string, unknown>; signal?: AbortSignal; started: number; aborted?: number };
const calls: Call[] = [];
const owner = '00000000-0000-4000-8000-000000000001';
const leader = { state: 'leader', owner };
const waiting = () => ({ state: 'waiting', retry_at: new Date(Date.now() + 60_000).toISOString() });
const payload = () => ({ outcome: 'success', transcript: [{ text: 'Caption.', start: 0, duration: 100 }],
  transcriptDuration: 100, isPartial: false, coverageRatio: 100, requestId: 'previous-visitor', language: 'en' });
const request = (body: Record<string, unknown> = {}, signal?: AbortSignal) => new NextRequest('http://localhost/api/transcript', {
  method: 'POST', body: JSON.stringify({ url: 'https://youtu.be/abcdefghijk', ...body }), signal,
});
const named = (name: string) => calls.filter(call => call.name === `transcript_cache_${name}`);
const fresh = () => vi.fn(async () => NextResponse.json(payload()));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => realSetImmediate(resolve)); };
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
function observe<T>(promise: Promise<T>) {
  const result: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  void promise.then(value => { result.value = value; result.settled = true; }, error => { result.error = error; result.settled = true; });
  return result;
}
function unavailable(result: { settled: boolean; error?: unknown }) {
  expect(result.settled).toBe(true);
  expect(result.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
}

function installRpc(plan: (call: Call) => Plan) {
  mocks.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
    const call: Call = { name, args, started: Date.now() };
    calls.push(call);
    let execution: Promise<RpcResult> | undefined;
    // Like PostgREST: rpc() returns a builder, abortSignal() chains, and awaiting
    // its thenable starts transport. It is deliberately not an eager Promise.
    const builder: PromiseLike<RpcResult> & { abortSignal(signal: AbortSignal): unknown } = {
      abortSignal(signal) { call.signal = signal; return builder; },
      then(onfulfilled, onrejected) {
        execution ??= new Promise<RpcResult>((resolve, reject) => {
          if (!call.signal) { reject(new Error('RPC transport requires abortSignal')); return; }
          const signal = call.signal;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const abort = () => {
            call.aborted = Date.now(); clearTimeout(timer);
            signal.removeEventListener('abort', abort); reject(signal.reason);
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) { abort(); return; }
          const next = plan(call);
          const finish = () => {
            signal.removeEventListener('abort', abort);
            resolve({ data: next.data, error: next.error ?? null });
          };
          if (next.delay === Infinity) return;
          if (next.delay) timer = setTimeout(finish, next.delay);
          else finish();
        });
        return execution.then(onfulfilled, onrejected);
      },
    };
    return builder;
  });
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T00:00:00Z'));
  mocks.rpc.mockReset(); calls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('reuseTranscript deadlines and cancellation', () => {
  it.each(['acquire', 'read'])('stalled %s rejects at its 5s transport deadline without fresh work', async phase => {
    installRpc(call => call.name === `transcript_cache_${phase}` ? { delay: Infinity } : { data: waiting() });
    const runFresh = fresh();
    const result = observe(reuseTranscript(request(), runFresh));
    await flush();
    if (phase === 'read') await advance(250);
    const call = named(phase)[0];
    expect(call.signal?.aborted).toBe(false);
    await advance(4999);
    expect(result.settled).toBe(false);
    await advance(1);
    unavailable(result);
    expect(call.aborted! - call.started).toBe(5000);
    expect(runFresh).not.toHaveBeenCalled();
    expect(named('finish')).toHaveLength(0);
  });

  it('forwards request cancellation into an in-flight read and rejects immediately', async () => {
    installRpc(call => call.name.endsWith('acquire') ? { data: waiting() } : { delay: Infinity });
    const controller = new AbortController();
    const runFresh = fresh();
    const result = observe(reuseTranscript(request({}, controller.signal), runFresh));
    await flush(); await advance(250);
    const read = named('read')[0];
    expect(read.signal?.aborted).toBe(false);
    const reason = new Error('client disconnected');
    controller.abort(reason); await flush();
    unavailable(result);
    expect(read.signal?.aborted).toBe(true);
    expect(read.signal?.reason).toBe(reason);
    expect(read.aborted).toBe(Date.now());
    expect(runFresh).not.toHaveBeenCalled();
  });

  it('caps total follower wait at 25s even when each read would finish within 5s', async () => {
    installRpc(call => ({ data: waiting(), delay: call.name.endsWith('read') ? 4000 : 0 }));
    const runFresh = fresh();
    const result = observe(reuseTranscript(request(), runFresh));
    await flush();
    const start = Date.now();
    await advance(24_999);
    expect(result.settled).toBe(false);
    expect(named('read')).toHaveLength(6);
    await advance(1);
    expect(result.value?.status).toBe(429);
    expect(await result.value!.json()).toMatchObject({ code: 'TRANSCRIPT_SPEND_THROTTLED', reason: 'cooldown' });
    expect(named('read').at(-1)?.aborted).toBe(start + 25_000);
    expect(runFresh).not.toHaveBeenCalled();
    expect(named('acquire')).toHaveLength(1);
    await advance(10_000);
    expect(named('read')).toHaveLength(6);
  });

  it.each(['direct result', 'paid dispatch'])('fences a late %s after 45s of leader work', async mode => {
    installRpc(call => ({ data: call.name.endsWith('acquire') ? leader : true }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dispatch = vi.fn();
    let late: ReturnType<typeof observe<NextResponse>> | undefined;
    const runFresh = vi.fn((signal?: AbortSignal) => {
      const work = (async () => {
        await gate;
        if (mode === 'paid dispatch') { await assertTranscriptCacheOwner(true); dispatch(); }
        return NextResponse.json(payload());
      })();
      late = observe(work);
      expect(signal?.aborted).toBe(false);
      return work;
    });
    const result = observe(reuseTranscript(request(), runFresh));
    await flush(); await advance(44_999);
    expect(result.settled).toBe(false);
    await advance(1);
    unavailable(result);
    expect(runFresh.mock.calls[0][0]?.aborted).toBe(true);
    expect(named('finish')).toHaveLength(1);
    expect(named('finish')[0].args).toMatchObject({ p_owner: owner, p_payload: null, p_uncertain: false });
    release(); await flush();
    expect(late?.settled).toBe(true);
    if (mode === 'paid dispatch') unavailable(late!);
    expect(dispatch).not.toHaveBeenCalled();
    expect(named('assert_owner')).toHaveLength(0);
    expect(named('finish')).toHaveLength(1);
  });

  it.each([false, true])('cancelled leader has independent 5s finish cleanup (possibly dispatched=%s)', async dispatched => {
    installRpc(call => ({ data: call.name.endsWith('acquire') ? leader : true,
      delay: call.name.endsWith('finish') ? Infinity : 0 }));
    const controller = new AbortController();
    let ready = false;
    const runFresh = vi.fn(async () => {
      if (dispatched) await assertTranscriptCacheOwner(true);
      ready = true;
      return new Promise<NextResponse>(() => {});
    });
    const result = observe(reuseTranscript(request({}, controller.signal), runFresh));
    await flush(); expect(ready).toBe(true);
    controller.abort(); await flush();
    const finish = named('finish')[0];
    expect(finish.args).toMatchObject({ p_owner: owner, p_payload: null, p_uncertain: dispatched });
    expect(finish.signal?.aborted).toBe(false);
    expect(named('assert_owner')).toHaveLength(dispatched ? 1 : 0);
    await advance(4999); expect(result.settled).toBe(false);
    await advance(1); unavailable(result);
    expect(finish.aborted! - finish.started).toBe(5000);
  });

  it('does not mark a known failure before dispatch uncertain', async () => {
    installRpc(call => ({ data: call.name.endsWith('acquire') ? leader : true }));
    const runFresh = vi.fn(async () => { await assertTranscriptCacheOwner(); throw new Error('direct failed before dispatch'); });
    const result = observe(reuseTranscript(request(), runFresh));
    await flush(); unavailable(result);
    expect(named('finish')[0].args).toMatchObject({ p_payload: null, p_uncertain: false });
  });

  it('bounds stalled publication to 5s after just-under-45s work, within the 60s lease', async () => {
    installRpc(call => ({ data: leader, delay: call.name.endsWith('finish') ? Infinity : 0 }));
    const runFresh = vi.fn(() => new Promise<NextResponse>(resolve => {
      setTimeout(() => resolve(NextResponse.json(payload())), 44_999);
    }));
    const start = Date.now();
    const result = observe(reuseTranscript(request(), runFresh));
    await flush(); await advance(44_999);
    const finish = named('finish')[0];
    expect(finish.args.p_payload).toMatchObject({ transcript: payload().transcript });
    expect(finish.args.p_payload).not.toHaveProperty('requestId');
    expect(finish.args.p_payload).not.toHaveProperty('coverageRatio');
    await advance(4999); expect(result.settled).toBe(false);
    await advance(1); unavailable(result);
    expect(Date.now() - start).toBe(49_999);
    expect(finish.aborted! - finish.started).toBe(5000);
  });
});

describe('reuseTranscript cache payloads', () => {
  it.each([undefined, 100, 200, 400])('recomputes request coverage for expectedDuration=%s and replaces correlation IDs', async expectedDuration => {
    const stored = payload();
    installRpc(() => ({ data: { state: 'hit', payload: stored } }));
    const runFresh = fresh();
    const response = await reuseTranscript(request({ expectedDuration }), runFresh);
    const body = await response.json();
    expect(body).toMatchObject({ transcript: stored.transcript, language: 'en', transcriptCache: 'hit',
      isPartial: expectedDuration === 400 });
    if (expectedDuration) expect(body.coverageRatio).toBe(Math.round(100 / expectedDuration * 100));
    else expect(body).not.toHaveProperty('coverageRatio');
    expect(body.requestId).toEqual(expect.any(String));
    expect(body.requestId).not.toBe(stored.requestId);
    expect(response.headers.get('x-request-id')).toBe(body.requestId);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(stored.requestId).toBe('previous-visitor');
    expect(runFresh).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['null state', null], ['unknown state', { state: 'other' }],
    ['invalid owner', { state: 'leader', owner: 'bad' }],
    ['invalid retry time', { state: 'waiting', retry_at: 'bad' }],
    ['missing payload', { state: 'hit' }],
    ['empty transcript', { state: 'hit', payload: { ...payload(), transcript: [] } }],
    ['partial transcript', { state: 'hit', payload: { ...payload(), isPartial: true } }],
    ['malformed segment', { state: 'hit', payload: { ...payload(), transcript: [null] } }],
    ['invalid duration', { state: 'hit', payload: { ...payload(), transcriptDuration: 'bad' } }],
  ])('fails closed for %s without fresh work', async (_label, data) => {
    installRpc(() => ({ data }));
    const runFresh = fresh();
    const result = observe(reuseTranscript(request(), runFresh));
    await flush();
    expect(runFresh).not.toHaveBeenCalled();
    expect(named('finish')).toHaveLength(0);
    unavailable(result);
  });
});
