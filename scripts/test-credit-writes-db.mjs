import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Disposable cluster, same approach as test-limiter-db.mjs: no URL/env input, no published ports.
const container = `longcut-credit-test-${process.pid}-${Date.now()}`;
const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'];
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const claims = (sub, role) => `SELECT set_config('request.jwt.claims', '${JSON.stringify(sub ? { sub, role } : { role })}', false);`;
const as = (sub, role) => `SET ROLE ${role}; ${claims(sub, role)}`;
function sql(text) { return execFileSync('docker', args, { input: text, encoding: 'utf8' }).trim().split('\n').at(-1); }
function rejected(text, pattern) {
  const result = spawnSync('docker', args, { input: text, encoding: 'utf8' });
  assert.notEqual(result.status, 0, `Expected rejection: ${text}`);
  assert.match(result.stderr, pattern);
}

execFileSync('docker', ['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17']);
try {
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    ready = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres']).status === 0;
    if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Disposable PostgreSQL did not become ready');
  // Supabase-like roles, auth helpers and default grants.
  sql(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE SCHEMA extensions; CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
    GRANT USAGE ON SCHEMA extensions TO PUBLIC;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb, created_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(auth.jwt()->>'sub', '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(auth.jwt()->>'role', '') $$;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DATABASE postgres SET search_path TO "$user", public, extensions;
  `);
  // Replay the history up to this fix. Some older files do not replay cleanly on a bare
  // cluster (pg_net, pg_cron, historical drift), so earlier statements are best effort;
  // the migration under test must apply cleanly.
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const target = '20261125120000_server_only_credit_writes.sql';
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql') && name < target).sort()) {
    spawnSync('docker', args.map(value => value === 'ON_ERROR_STOP=1' ? 'ON_ERROR_STOP=0' : value), {
      input: readFileSync(new URL(file, dir), 'utf8').replace(/^CREATE EXTENSION IF NOT EXISTS "pg_net".*$/m, ''), encoding: 'utf8' });
  }
  sql(readFileSync(new URL(target, dir), 'utf8'));
  sql(`INSERT INTO auth.users (id) VALUES ('${A}'), ('${B}');
    INSERT INTO public.profiles (id, topup_credits) VALUES ('${A}', 2), ('${B}', 0);`);

  // Clients cannot add top-up credits or change billing columns.
  for (const role of ['anon', 'authenticated']) {
    rejected(`${as(A, role)} SELECT public.increment_topup_credits('${A}', 100);`, /permission denied/);
  }
  for (const change of ['topup_credits = 999', "subscription_tier = 'premium'", "subscription_status = 'active'",
    "subscription_current_period_end = now() + interval '1 year'", 'cancel_at_period_end = true', "stripe_subscription_id = 'sub_x'"]) {
    rejected(`${as(A, 'authenticated')} UPDATE public.profiles SET ${change} WHERE id = '${A}';`, /Billing fields can only be changed by the server/);
  }
  // Profile edits the app makes with the session client still work.
  sql(`${as(A, 'authenticated')} UPDATE public.profiles SET full_name = 'A', updated_at = now() WHERE id = '${A}';`);
  sql(`${as(A, 'authenticated')} UPDATE public.profiles SET stripe_customer_id = 'cus_test' WHERE id = '${A}';`);
  assert.equal(sql(`SELECT full_name || ' ' || stripe_customer_id FROM public.profiles WHERE id = '${A}'`), 'A cus_test');

  // Credit RPCs only act on the caller's own account.
  const period = "now() - interval '1 day', now() + interval '1 day'";
  rejected(`${as(B, 'authenticated')} SELECT public.consume_topup_credit('${A}');`, /Not allowed to use credits for another user/);
  rejected(`${as(B, 'authenticated')} SELECT consume_video_credit_atomically('${A}', 'yt-b', 'user:b', 'pro', 0, ${period}, NULL, true);`, /Not allowed/);
  rejected(`${as(B, 'authenticated')} SELECT public.consume_image_credit_atomically('${A}', 'yt-b', 'pro', 5, ${period}, NULL, true);`, /Not allowed/);
  assert.equal(sql(`SELECT topup_credits FROM public.profiles WHERE id = '${A}'`), '2');
  assert.equal(sql(`${as(A, 'authenticated')} SELECT public.consume_topup_credit('${A}');`), 't');
  // Spending a top-up inside the SECURITY DEFINER function is still allowed.
  assert.match(sql(`${as(A, 'authenticated')} SELECT consume_video_credit_atomically('${A}', 'yt-a', 'user:a', 'pro', 0, ${period}, NULL, true);`), /"used_topup": true/);
  assert.match(sql(`${as(A, 'authenticated')} SELECT public.consume_image_credit_atomically('${A}', 'yt-a', 'pro', 5, ${period}, NULL, true);`), /"allowed": true/);
  assert.equal(sql(`SELECT topup_credits FROM public.profiles WHERE id = '${A}'`), '0');

  // The server (service role) keeps full control.
  sql(`${as(null, 'service_role')} SELECT public.increment_topup_credits('${A}', 5);`);
  assert.equal(sql(`${as(null, 'service_role')} SELECT public.consume_topup_credit('${A}');`), 't');
  sql(`${as(null, 'service_role')} UPDATE public.profiles SET subscription_tier = 'premium', subscription_status = 'active' WHERE id = '${B}';`);
  assert.equal(sql(`SELECT topup_credits || ' ' || (SELECT subscription_tier FROM public.profiles WHERE id = '${B}') FROM public.profiles WHERE id = '${A}'`), '4 premium');

  // The replaced upsert is no longer callable by clients.
  for (const role of ['anon', 'authenticated']) {
    rejected(`${as(A, role)} SELECT public.upsert_video_analysis_with_user_link('yt9', 't', 'a', 1, 'u', '[]', '[]', '{}', '[]', 'm', '${A}', 'en', '[]');`, /permission denied/);
  }

  // Session audit rows belong to the signed-in user, or to nobody.
  const audit = user => `INSERT INTO public.audit_logs (user_id, action, resource_type, ip_address, user_agent) VALUES (${user}, 'X', 'T', 'i', 'u');`;
  sql(`${as(A, 'authenticated')} ${audit(`'${A}'`)}`);
  sql(`${as(null, 'anon')} ${audit('NULL')}`);
  rejected(`${as(A, 'authenticated')} ${audit(`'${B}'`)}`, /row-level security/);
  rejected(`${as(null, 'anon')} ${audit(`'${B}'`)}`, /row-level security/);
  sql(`${as(null, 'service_role')} ${audit(`'${B}'`)}`);
  console.log('credit write checks passed');
} finally {
  spawnSync('docker', ['rm', '-f', container]);
}
