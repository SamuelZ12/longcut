import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

const container = process.env.TRANSCRIPT_CACHE_TEST_CONTAINER;
const local = !!container && /^longcut-cache-test-\d+-\d+$/.test(container);
// Each call starts a separate psql process/connection, including concurrent calls.
function sql(text: string): Promise<string> {
  if (!local) throw new Error('Disposable local PostgreSQL required');
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', container!, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim().split('\n').at(-1) ?? ''));
    child.stdin!.end(text);
  });
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const key = (lang: string | null = null, video = 'abcdefghijk') => JSON.stringify(['supadata', 'native', 'v1', video, lang]);
const payload = { transcript: [{ text: 'Public caption.', start: 0, duration: 5 }], isPartial: false,
  language: 'en', availableLanguages: ['en', 'es'] };
type CacheResult = { state: 'leader' | 'waiting' | 'hit' | 'miss'; owner?: string; retry_at?: string; payload?: typeof payload };
const acquire = async (k = key(), refresh = false): Promise<CacheResult> => JSON.parse(await sql(
  `SET ROLE service_role; SELECT public.transcript_cache_acquire(${quote(k)},${refresh})`));
const read = async (k = key()): Promise<CacheResult> => JSON.parse(await sql(
  `SET ROLE service_role; SELECT public.transcript_cache_read(${quote(k)})`));
const assertOwner = (owner: string | null, k = key()) => sql(
  `SET ROLE service_role; SELECT public.transcript_cache_assert_owner(${quote(k)},${owner === null ? 'NULL' : quote(owner)})`);
const finish = (owner: string, value: unknown = payload, uncertain = false, k = key()) => sql(
  `SET ROLE service_role; SELECT public.transcript_cache_finish(${quote(k)},${quote(owner)},${value === null ? 'NULL' : quote(JSON.stringify(value)) + '::jsonb'},${uncertain})`);
const ageCooldown = () => sql("UPDATE public.transcript_cache SET retry_at=clock_timestamp()-interval '1 second', lease_until=CASE WHEN owner IS NULL THEN NULL ELSE clock_timestamp()-interval '11 minutes' END");

describe.skipIf(!local)('shared public transcript cache: actual PostgreSQL connections', () => {
  beforeEach(async () => { await sql('TRUNCATE public.transcript_cache'); });

  it('read misses do not elect or write; separate-process reload retains transcript and metadata for 30 days', async () => {
    expect(await read()).toEqual({ state: 'miss' });
    expect(await sql('SELECT count(*) FROM public.transcript_cache')).toBe('0');
    const leader = await acquire();
    expect(leader.state).toBe('leader');
    expect(await finish(leader.owner!)).toBe('t');
    expect(await read()).toEqual({ state: 'hit', payload });
    expect(await acquire()).toEqual({ state: 'hit', payload });
    expect(await sql("SELECT expires_at BETWEEN clock_timestamp()+interval '29 days 23 hours' AND clock_timestamp()+interval '30 days' FROM public.transcript_cache")).toBe('t');
    expect(await sql("SELECT private_data FROM public.video_analyses WHERE id=1")).toBe('private sentinel');
  });

  it('independent concurrent workers elect exactly one dispatching leader; followers and hits dispatch zero', async () => {
    let mockedDispatches = 0;
    const results = await Promise.all(Array.from({ length: 12 }, async () => {
      const result = await acquire();
      if (result.state === 'leader') mockedDispatches++;
      return result;
    }));
    expect(mockedDispatches).toBe(1);
    expect(results.filter(r => r.state === 'waiting')).toHaveLength(11);
    expect(new Set(results.filter(r => r.state === 'waiting').map(r => r.retry_at)).size).toBe(1);
    expect(await finish(results.find(r => r.state === 'leader')!.owner!)).toBe('t');
    expect((await Promise.all(Array.from({ length: 4 }, () => read()))).every(r => r.state === 'hit')).toBe(true);
    expect((await acquire()).state).toBe('hit');
    expect(mockedDispatches).toBe(1);
  });

  it('keeps requested languages, automatic language and videos separate; rejects alternate modes/spellings', async () => {
    const keys = [key(), key('en'), key('es'), key('en', '01234567890')];
    const results = await Promise.all(keys.map(k => acquire(k)));
    expect(results.every(r => r.state === 'leader')).toBe(true);
    expect(new Set(results.map(r => r.owner)).size).toBe(4);
    await finish(results[1].owner!, payload, false, keys[1]);
    expect((await read(keys[1])).state).toBe('hit');
    expect((await read(keys[2])).state).toBe('waiting');
    for (const invalid of [key('EN'), key().replace('native', 'auto'), key().replace('v1', 'v2'), 'x', key().replace(',', ', ')]) {
      await expect(acquire(invalid)).rejects.toThrow('Invalid canonical transcript cache key');
    }
  });

  it('refresh bypasses fresh data but joins active work; non-refresh callers retain fresh data', async () => {
    await finish((await acquire()).owner!);
    const refresh = await acquire(key(), true);
    expect(refresh.state).toBe('leader');
    expect((await acquire(key(), true)).state).toBe('waiting');
    expect((await read()).state).toBe('waiting');
    expect(await acquire()).toEqual({ state: 'hit', payload });
    const updated = { ...payload, language: 'es' };
    expect(await finish(refresh.owner!, updated)).toBe('t');
    expect(await read()).toEqual({ state: 'hit', payload: updated });
  });

  it('failed refresh preserves prior freshness without extending TTL and throttles explicit refresh', async () => {
    await finish((await acquire()).owner!);
    const expiry = await sql('SELECT expires_at FROM public.transcript_cache');
    const refresh = await acquire(key(), true);
    expect(await finish(refresh.owner!, null, true)).toBe('t');
    expect(await read()).toEqual({ state: 'hit', payload });
    expect(await acquire()).toEqual({ state: 'hit', payload });
    expect((await acquire(key(), true)).state).toBe('waiting');
    expect(await sql('SELECT expires_at FROM public.transcript_cache')).toBe(expiry);
  });

  it('expired payload is not reusable; read never elects; acquisition starts a new lease', async () => {
    await finish((await acquire()).owner!);
    await sql("UPDATE public.transcript_cache SET expires_at=clock_timestamp()-interval '1 second'");
    expect(await read()).toEqual({ state: 'miss' });
    expect(await sql('SELECT owner IS NULL FROM public.transcript_cache')).toBe('t');
    expect((await acquire()).state).toBe('leader');
  });

  it('abandoned lease stays quarantined ten minutes beyond expiry and rejects stale workers before and after replacement', async () => {
    const first = await acquire();
    expect(await sql("SELECT lease_until BETWEEN clock_timestamp()+interval '55 seconds' AND clock_timestamp()+interval '60 seconds' AND retry_at=lease_until+interval '10 minutes' FROM public.transcript_cache")).toBe('t');
    await sql("UPDATE public.transcript_cache SET lease_until=clock_timestamp()-interval '1 second',retry_at=clock_timestamp()+interval '599 seconds'");
    expect((await acquire()).state).toBe('waiting');
    expect((await read()).state).toBe('waiting');
    expect(await finish(first.owner!)).toBe('f');
    await ageCooldown();
    expect(await read()).toEqual({ state: 'miss' });
    const second = await acquire();
    expect(second.state).toBe('leader');
    expect(second.owner).not.toBe(first.owner);
    expect(await finish(first.owner!)).toBe('f');
    expect(await finish(second.owner!)).toBe('t');
  });

  it.each([false, true])('failure uncertain=%s enforces known/uncertain cooldown with no reusable result', async uncertain => {
    expect(await finish((await acquire()).owner!, null, uncertain)).toBe('t');
    const result = await read();
    expect(result.state).toBe('waiting');
    const seconds = (Date.parse(result.retry_at!) - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(uncertain ? 595 : 25);
    expect(seconds).toBeLessThanOrEqual(uncertain ? 601 : 31);
    expect((await Promise.all(Array.from({ length: 6 }, () => acquire()))).every(r => r.state === 'waiting')).toBe(true);
    expect(await sql('SELECT payload IS NULL AND owner IS NULL FROM public.transcript_cache')).toBe('t');
    await ageCooldown();
    expect((await acquire()).state).toBe('leader');
  });

  it.each([
    { transcript: [], isPartial: false }, { ...payload, isPartial: true }, { transcript: payload.transcript },
    { transcript: 'wrong', isPartial: false }, { ...payload, isPartial: 'false' }, {},
  ])('incomplete/malformed payload is not persisted: %j', async value => {
    expect(await finish((await acquire()).owner!, value)).toBe('t');
    expect((await read()).state).toBe('waiting');
    expect(await sql('SELECT payload IS NULL FROM public.transcript_cache')).toBe('t');
  });

  it('uncertain outcome cannot publish even a valid payload; wrong owner and replay cannot alter work', async () => {
    const leader = await acquire();
    expect(await finish(randomUUID())).toBe('f');
    expect(await finish(leader.owner!, payload, true)).toBe('t');
    expect(await finish(leader.owner!)).toBe('f');
    expect((await read()).state).toBe('waiting');
    expect(await sql('SELECT payload IS NULL FROM public.transcript_cache')).toBe('t');
  });

  it('owner assertion accepts only a live matching owner without renewing or changing work', async () => {
    expect(await assertOwner(randomUUID())).toBe('f');
    const leader = await acquire();
    const before = await sql('SELECT row_to_json(c) FROM public.transcript_cache c');
    expect(await assertOwner(leader.owner!)).toBe('t');
    expect(await assertOwner(randomUUID())).toBe('f');
    expect(await assertOwner(null)).toBe('f');
    expect(await assertOwner(leader.owner!, key('es'))).toBe('f');
    expect(await sql('SELECT row_to_json(c) FROM public.transcript_cache c')).toBe(before);
    await sql("UPDATE public.transcript_cache SET lease_until=clock_timestamp()-interval '1 second'");
    expect(await assertOwner(leader.owner!)).toBe('f');
    await ageCooldown();
    const replacement = await acquire();
    expect(await assertOwner(leader.owner!)).toBe('f');
    expect(await assertOwner(replacement.owner!)).toBe('t');
    await finish(replacement.owner!);
    expect(await assertOwner(replacement.owner!)).toBe('f');
  });

  it('transaction rollback releases election; concurrent finish accepts exactly one publication', async () => {
    await sql(`BEGIN; SET LOCAL ROLE service_role; SELECT public.transcript_cache_acquire(${quote(key())}); ROLLBACK`);
    expect(await read()).toEqual({ state: 'miss' });
    const leader = await acquire();
    const results = await Promise.all(Array.from({ length: 6 }, () => finish(leader.owner!)));
    expect(results.filter(v => v === 't')).toHaveLength(1);
    expect(results.filter(v => v === 'f')).toHaveLength(5);
  });

  it('checks lease time after lock contention, not transaction start', async () => {
    const leader = await acquire();
    await sql("UPDATE public.transcript_cache SET lease_until=clock_timestamp()+interval '1 second'");
    const held = sql(`BEGIN; SET application_name='cache-lock-test'; SELECT pg_advisory_xact_lock(hashtextextended('transcript-cache:' || ${quote(key())},0)); SELECT pg_sleep(2); COMMIT`);
    let locked = false;
    for (let i = 0; i < 30; i++) {
      if (await sql("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='cache-lock-test' AND wait_event='PgSleep')") === 't') { locked = true; break; }
    }
    expect(locked).toBe(true);
    const [result, assertion] = await Promise.all([finish(leader.owner!), assertOwner(leader.owner!)]);
    await held;
    expect(result).toBe('f');
    expect(assertion).toBe('f');
  });

  it('validates exact live flow identity/video without claiming any operation', async () => {
    const flow = await sql("SET ROLE service_role; SELECT public.create_initial_analysis_flow('abcdefghijk','guest',ARRAY['token:one','ip:one'])");
    const validate = (id = flow, video = 'abcdefghijk', ids = "ARRAY['token:one','ip:one']") => sql(
      `SET ROLE service_role; SELECT public.validate_initial_analysis_flow('${id}','${video}',${ids})`);
    expect(await validate()).toBe('t');
    expect(await validate(randomUUID())).toBe('f');
    expect(await validate(flow, '01234567890')).toBe('f');
    expect(await validate(flow, 'abcdefghijk', "ARRAY['token:other','ip:one']")).toBe('f');
    expect(await validate(flow, 'abcdefghijk', "ARRAY['ip:one','token:one']")).toBe('f');
    expect(await validate(flow, 'abcdefghijk', 'NULL::text[]')).toBe('f');
    expect(await sql(`SELECT count(*) FROM public.initial_analysis_operations WHERE flow_id='${flow}'`)).toBe('0');
    await sql(`INSERT INTO public.initial_analysis_operations(flow_id,operation) VALUES('${flow}','summary')`);
    expect(await validate()).toBe('t');
    expect(await sql(`SET ROLE service_role; SELECT public.claim_initial_analysis_operation('${flow}','abcdefghijk',ARRAY['token:one','ip:one'],'transcript','guest')`)).toBe('t');
    expect(await validate()).toBe('f');
    await sql(`SET ROLE service_role; SELECT public.finish_initial_analysis_operation('${flow}','transcript')`);
    expect(await validate()).toBe('f');
    await sql(`DELETE FROM public.initial_analysis_operations WHERE flow_id='${flow}' AND operation='transcript'`);
    expect(await validate()).toBe('t');
    await sql(`UPDATE public.initial_analysis_flows SET complete=true WHERE id='${flow}'`);
    expect(await validate()).toBe('f');
    await sql(`UPDATE public.initial_analysis_flows SET complete=false,expires_at=clock_timestamp()-interval '1 second' WHERE id='${flow}'`);
    expect(await validate()).toBe('f');
  });

  it('denies browser RPCs/direct table access and isolates executor from private data and spend ledgers', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const call of [
        `transcript_cache_acquire(${quote(key())})`, `transcript_cache_read(${quote(key())})`,
        `transcript_cache_assert_owner(${quote(key())},'${randomUUID()}')`,
        `validate_initial_analysis_flow('${randomUUID()}','abcdefghijk',ARRAY['forged'])`,
        `transcript_cache_finish(${quote(key())},'${randomUUID()}',NULL)`, `transcript_cache_validate_key(${quote(key())})`,
      ]) await expect(sql(`SET ROLE ${role}; SELECT public.${call}`)).rejects.toThrow('permission denied');
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const query of ['SELECT * FROM public.transcript_cache',
        `INSERT INTO public.transcript_cache(key) VALUES(${quote(key())})`,
        'UPDATE public.transcript_cache SET owner=NULL', 'DELETE FROM public.transcript_cache',
        'TRUNCATE public.transcript_cache']) {
        await expect(sql(`SET ROLE ${role}; ${query}`)).rejects.toThrow('permission denied');
      }
      await expect(sql(`SET SESSION AUTHORIZATION ${role}; SET ROLE transcript_cache_executor`)).rejects.toThrow('permission denied');
    }
    for (const table of ['video_analyses', 'transcript_spend_attempts', 'guest_analysis_usage', 'initial_ai_attempts']) {
      await expect(sql(`SET ROLE transcript_cache_executor; SELECT * FROM public.${table}`)).rejects.toThrow('permission denied');
      await expect(sql(`SET ROLE transcript_cache_executor; DELETE FROM public.${table}`)).rejects.toThrow('permission denied');
    }
    expect(await sql('SET ROLE authenticated; SELECT count(*) FROM public.video_analyses')).toBe('0');
    await expect(sql("SET ROLE authenticated; INSERT INTO public.video_analyses VALUES(2,'private')")).rejects.toThrow('row-level security');
    await sql("SET ROLE authenticated; UPDATE public.video_analyses SET private_data='changed'; DELETE FROM public.video_analyses");
    expect(await sql('SELECT private_data FROM public.video_analyses')).toBe('private sentinel');
    expect(await sql("SELECT NOT rolcanlogin AND NOT rolbypassrls AND NOT rolsuper AND NOT rolinherit FROM pg_roles WHERE rolname='transcript_cache_executor'")).toBe('t');
    expect(await sql("SELECT count(*) FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname IN ('transcript_cache_acquire','transcript_cache_finish','transcript_cache_read','transcript_cache_assert_owner') AND r.rolname='transcript_cache_executor' AND p.prosecdef AND p.proconfig=ARRAY['search_path=\"\"']")).toBe('4');
    expect(await sql("SELECT NOT has_schema_privilege('transcript_cache_executor','public','CREATE') AND NOT pg_has_role('migration_executor','transcript_cache_executor','SET') AND NOT pg_has_role('migration_executor','transcript_cache_executor','USAGE')")).toBe('t');
    expect(await sql("SELECT p.prosecdef AND p.proconfig=ARRAY['search_path=\"\"'] AND r.rolname='transcript_spend_executor' FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname='validate_initial_analysis_flow'")).toBe('t');
  });
});
