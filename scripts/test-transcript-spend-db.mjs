import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// No connection strings, environment credentials, or host ports. Disposable local cluster only.
const container = `longcut-spend-test-${process.pid}-${Date.now()}`;
const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'];
const sql = text => execFileSync('docker', args, { input: text, encoding: 'utf8' }).trim();
const parse = output => JSON.parse(output.trim().split('\n').at(-1));
const call = (tier = 'free', ids = ['user:one'], key = 'video:en') =>
  `SET ROLE service_role; SELECT public.reserve_transcript_spend('native-v1','${tier}',ARRAY[${ids.map(v => `'${v}'`).join(',')}],'${key}');`;
const reserve = (...values) => parse(sql(call(...values)));
const transition = (id, action) => sql(`SET ROLE service_role; SELECT public.transition_transcript_spend('${id}', '${action}')`).split('\n').at(-1);
const reset = () => sql('TRUNCATE public.transcript_spend_attempts');
function denied(text) {
  const result = spawnSync('docker', args, { input: text, encoding: 'utf8' });
  assert.notEqual(result.status, 0, text);
  assert.match(result.stderr, /permission denied/);
}
function worker(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args);
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(parse(out)) : reject(new Error(err)));
    child.stdin.end(text);
  });
}
execFileSync('docker', ['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17']);
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready);
  sql(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE migration_executor LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
    ALTER DATABASE postgres OWNER TO migration_executor; REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE TABLE public.rate_limits(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, key text, identifier text, timestamp timestamptz DEFAULT now());
    ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.rate_limits OWNER TO migration_executor;
    CREATE FUNCTION public.cleanup_old_rate_limits() RETURNS void LANGUAGE sql AS $$ DELETE FROM public.rate_limits $$;
    ALTER FUNCTION public.cleanup_old_rate_limits() OWNER TO migration_executor;
    INSERT INTO public.rate_limits(key, identifier, timestamp) VALUES ('guest-analysis','historical-guest',now()-interval '90 days');`);
  const executorArgs = args.map(v => v === 'postgres' ? 'migration_executor' : v);
  // Explicit database: the non-superuser defaults to a same-named database otherwise.
  executorArgs.push('-d', 'postgres');
  const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
  execFileSync('docker', executorArgs, { input: migration('20260923060000_server_only_limiter.sql'), encoding: 'utf8' });
  const spendMigration = migration('20260925040000_transcript_vendor_spend.sql');
  const failed = spawnSync('docker', executorArgs, { encoding: 'utf8', input: spendMigration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'injected'; END $$; COMMIT;") });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /injected/);
  assert.equal(sql("SELECT to_regclass('public.guest_analysis_usage') IS NULL"), 't');
  // An old RPC transaction remains open while migration starts; trigger installation
  // must wait, then include that committed legacy write in its backfill.
  const legacyWriter = worker(`SET application_name='legacy-guest-cutover'; BEGIN; SET ROLE service_role;
    SELECT public.guest_usage_server(ARRAY['inflight-guest'],true); SELECT pg_sleep(1); COMMIT; SELECT '{}'::jsonb;`);
  let writerWaiting = false;
  for (let i = 0; i < 50; i++) {
    if (sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='legacy-guest-cutover' AND wait_event='PgSleep'") === '1') { writerWaiting = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(writerWaiting);
  execFileSync('docker', executorArgs, { input: spendMigration, encoding: 'utf8' });
  await legacyWriter;
  assert.equal(reserve('guest',['inflight-guest']).reason, 'guest_used');
  // Models an old cached function body that resumes its INSERT after migration commit.
  sql("SET ROLE limiter_executor; INSERT INTO public.rate_limits(key,identifier) VALUES ('guest-analysis','late-legacy-guest')");
  assert.equal(reserve('guest',['late-legacy-guest']).reason, 'guest_used');
  assert.equal(sql("SELECT pg_has_role('migration_executor','transcript_spend_executor','SET') OR pg_has_role('migration_executor','transcript_spend_executor','USAGE')"), 'f');
  assert.equal(sql("SELECT rolcanlogin OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname='transcript_spend_executor'"), 'f');
  assert.equal(sql("SELECT has_schema_privilege('transcript_spend_executor','public','CREATE')"), 'f');
  assert.equal(sql("SELECT count(*) FROM pg_proc WHERE proname IN ('reserve_transcript_spend','transition_transcript_spend') AND proowner='transcript_spend_executor'::regrole AND prosecdef AND proconfig=ARRAY['search_path=\"\"']"), '2');
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['transcript_spend_attempts', 'guest_analysis_usage']) {
      for (const statement of [`SELECT * FROM public.${table}`, `DELETE FROM public.${table}`, `TRUNCATE public.${table}`]) denied(`SET ROLE ${role}; ${statement}`);
    }
    denied(`SET ROLE ${role}; INSERT INTO public.guest_analysis_usage(identifier) VALUES ('forged')`);
    denied(`SET ROLE ${role}; UPDATE public.transcript_spend_attempts SET state='released'`);
    denied(`SET ROLE ${role}; SELECT public.reserve_transcript_spend('native-v1','unlimited',ARRAY['user:forged'],'forged')`);
    for (const action of ['dispatch', 'release', 'complete', 'uncertain']) denied(`SET ROLE ${role}; SELECT public.transition_transcript_spend('00000000-0000-4000-8000-000000000001','${action}')`);
    denied(`SET ROLE ${role}; SELECT public.guest_usage_server(ARRAY['forged'],true)`);
    denied(`SET ROLE ${role}; SELECT public.preserve_legacy_guest_usage()`);
  }
  denied("SET ROLE service_role; UPDATE public.transcript_spend_attempts SET state='released'");
  console.log('PASS: transactional migration with non-superuser; definer privileges; real anon/authenticated forged identity and transition rejection.');

  const id = reserve().reservation_id;
  assert.ok(id);
  assert.equal(transition(id, 'release'), 't');
  const retry = reserve().reservation_id;
  assert.equal(transition(retry, 'dispatch'), 't');
  assert.equal(transition(retry, 'release'), 'f');
  assert.equal(transition(retry, 'dispatch'), 'f');
  assert.equal(transition(retry, 'uncertain'), 't');
  assert.equal(reserve('pro', ['user:other']).reason, 'cooldown');
  sql("UPDATE public.transcript_spend_attempts SET lease_until=now()-interval '1 second', blocked_until=now()-interval '1 second'");
  assert.equal(reserve('pro', ['user:other']).allowed, true);
  assert.equal(sql("SELECT count(*) FROM public.transcript_spend_attempts WHERE state <> 'released'"), '2');
  console.log('PASS: pre-dispatch release; no refund/re-dispatch after possible dispatch; cross-identity uncertainty quarantine and explicit retry.');

  // Every matrix row exercises the actual rolling-window admission, not a copied configuration assertion.
  for (const [tier, day, month, concurrent] of [['guest',2,6,1],['free',5,30,1],['topup',25,300,2],['pro',25,300,2],['unlimited',50,600,2]]) {
    reset();
    const ids = tier === 'guest' ? ['token-one','ip:one'] : ['user:one'];
    for (let i = 0; i < day; i++) {
      const admission = reserve(tier, ids, `video:${i}`);
      assert.equal(admission.allowed, true, `${tier} day attempt ${i}`);
      assert.equal(transition(admission.reservation_id, 'dispatch'), 't');
      assert.equal(transition(admission.reservation_id, 'complete'), 't');
    }
    assert.equal(reserve(tier, ids, 'extra').reason, 'budget');
    reset();
    sql(`INSERT INTO public.transcript_spend_attempts(identifiers,request_key,counted_at,state,lease_until,blocked_until)
      SELECT ARRAY['${ids[0]}'],'old:'||i,now()-interval '2 days','complete',now(),now() FROM generate_series(1,${month}) i;`);
    const monthly = reserve(tier, ids, 'extra');
    assert.equal(monthly.reason, 'budget');
    assert.ok(Date.parse(monthly.retry_at) > Date.now() + 27 * 86400000);
    sql("UPDATE public.transcript_spend_attempts SET counted_at=now()-interval '31 days'");
    assert.equal(reserve(tier, ids, 'after-expiry').allowed, true);
    reset();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => worker(call(tier, ids, `parallel:${i}`))));
    assert.equal(results.filter(r => r.allowed).length, concurrent, tier);
  }
  console.log('PASS: guest/free/top-up/pro/unlimited daily and monthly limits, rolling expiry, independent-worker per-identity concurrency.');

  reset();
  const global = await Promise.all(Array.from({ length: 16 }, (_, i) => worker(call('unlimited', [`user:${i}`], `parallel:${i}`))));
  assert.equal(global.filter(r => r.allowed).length, 10);
  for (const [count, age] of [[200, '1 hour'],[5000, '2 days']]) {
    reset();
    sql(`INSERT INTO public.transcript_spend_attempts(identifiers,request_key,counted_at,state,lease_until,blocked_until)
      SELECT ARRAY['user:'||i],'global:'||i,now()-interval '${age}','complete',now(),now() FROM generate_series(1,${count}) i;`);
    assert.equal(reserve('unlimited',['user:new'],'new').reason, 'budget');
  }
  reset();
  sql(`INSERT INTO public.transcript_spend_attempts(identifiers,request_key,counted_at,state,lease_until,blocked_until)
    SELECT ARRAY['user:one'],'tier:'||i,now()-interval '1 hour','complete',now(),now() FROM generate_series(1,5) i;`);
  assert.equal(reserve('free').allowed, false);
  assert.equal(reserve('pro').allowed, true);
  assert.equal(reserve('free', ['user:one'], 'downgraded').allowed, false);
  console.log('PASS: global daily/monthly caps and 10-worker ceiling; upgrades/downgrades preserve counted usage.');

  reset();
  const guests = await Promise.all(Array.from({ length: 8 }, (_, i) => worker(call('guest',[`reset-token:${i}`,'ip:same'],`first:${i}`))));
  assert.equal(guests.filter(r => r.allowed).length, 1);
  sql("SET ROLE service_role; SELECT public.guest_usage_server(ARRAY['stable-token','ip:same'],true)");
  sql("SELECT public.cleanup_old_rate_limits(); DELETE FROM public.rate_limits WHERE key='guest-analysis';");
  reset();
  assert.equal(reserve('guest',['reset-token','ip:same']).reason,'guest_used');
  assert.equal(reserve('guest',['stable-token','ip:changed']).reason,'guest_used');
  assert.equal(reserve('guest',['historical-guest','ip:new']).reason,'guest_used');
  assert.equal(reserve('guest',['new-human','ip:new']).allowed,true);
  console.log('PASS: durable historical/new guest-used state survives limiter cleanup and cookie/IP reset; simultaneous first requests share trusted IP budget.');

  const routes = spawnSync('npx', ['vitest', 'run', 'tests/transcript-spend-db.test.ts'], {
    env: { ...process.env, TRANSCRIPT_TEST_CONTAINER: container }, stdio: 'inherit',
  });
  assert.equal(routes.status, 0, 'Actual route + database integration');

  reset();
  sql(`CREATE FUNCTION public.reject_spend() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage failure'; END $$;
    CREATE TRIGGER reject_spend BEFORE INSERT ON public.transcript_spend_attempts FOR EACH ROW EXECUTE FUNCTION public.reject_spend();`);
  const failedWrite = spawnSync('docker', args, { input: call(), encoding: 'utf8' });
  assert.notEqual(failedWrite.status, 0);
  assert.match(failedWrite.stderr, /storage failure/);
  assert.equal(sql('SELECT count(*) FROM public.transcript_spend_attempts'), '0');
  console.log('PASS: write failure never grants admission. All database assertions passed.');
} finally {
  execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
