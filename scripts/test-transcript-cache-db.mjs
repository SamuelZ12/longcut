import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Disposable local PostgreSQL only. No external URL, credentials or published port.
const container = `longcut-cache-test-${process.pid}-${Date.now()}`;
const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'];
execFileSync('docker', ['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17']);
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Disposable PostgreSQL ready');
  execFileSync('docker', args, { input: `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE migration_executor LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
    ALTER DATABASE postgres OWNER TO migration_executor; REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE TABLE public.video_analyses(id integer PRIMARY KEY, private_data text);
    INSERT INTO public.video_analyses VALUES (1, 'private sentinel');
    ALTER TABLE public.video_analyses ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.video_analyses TO authenticated;
    CREATE TABLE public.rate_limits(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,key text,identifier text,timestamp timestamptz DEFAULT now());
    ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY; ALTER TABLE public.rate_limits OWNER TO migration_executor;
    CREATE FUNCTION public.cleanup_old_rate_limits() RETURNS void LANGUAGE sql AS $$ DELETE FROM public.rate_limits $$;
    ALTER FUNCTION public.cleanup_old_rate_limits() OWNER TO migration_executor;`, encoding: 'utf8' });
  for (const name of ['20260923060000_server_only_limiter.sql', '20260925040000_transcript_vendor_spend.sql',
    '20260925050000_initial_analysis_spend.sql', '20260925060000_shared_transcript_cache.sql', '20260925070000_initial_analysis_completion.sql']) {
    execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'migration_executor', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
      input: readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'), encoding: 'utf8',
    });
  }
  const result = spawnSync('npx', ['vitest', 'run', '--no-file-parallelism', 'tests/transcript-cache-db.test.ts', 'tests/transcript-cache-routes-db.test.ts'], {
    env: { ...process.env, TRANSCRIPT_CACHE_TEST_CONTAINER: container }, stdio: 'inherit',
  });
  assert.equal(result.status, 0, 'Transcript-cache PostgreSQL integration');
} finally { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); }
