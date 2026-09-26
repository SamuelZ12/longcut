-- Public caption data only; independent of analyses, ownership and credit ledgers.
BEGIN;
-- Validate reusable-flow access before shared cache election without claiming work.
CREATE FUNCTION public.validate_initial_analysis_flow(p_flow uuid, p_video text, p_identifiers text[])
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT FROM public.initial_analysis_flows
    WHERE id = p_flow AND video_id = p_video AND identifiers = p_identifiers
      AND NOT complete AND expires_at > clock_timestamp()
      AND NOT EXISTS (SELECT FROM public.initial_analysis_operations
        WHERE flow_id = p_flow AND operation = 'transcript'));
$$;
GRANT transcript_spend_executor TO CURRENT_USER WITH SET TRUE, INHERIT TRUE;
GRANT CREATE ON SCHEMA public TO transcript_spend_executor;
ALTER FUNCTION public.validate_initial_analysis_flow(uuid,text,text[]) OWNER TO transcript_spend_executor;
REVOKE CREATE ON SCHEMA public FROM transcript_spend_executor;
REVOKE ALL ON FUNCTION public.validate_initial_analysis_flow(uuid,text,text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.validate_initial_analysis_flow(uuid,text,text[]) TO service_role;
GRANT transcript_spend_executor TO CURRENT_USER WITH SET FALSE, INHERIT FALSE;

CREATE ROLE transcript_cache_executor NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO transcript_cache_executor;

CREATE TABLE public.transcript_cache (
  key text PRIMARY KEY CHECK (length(key) <= 512 AND key ~ '^\["supadata","native","v1","[A-Za-z0-9_-]{11}",(null|"[a-z]{2,3}(-[a-z0-9]{2,8})*")\]$'),
  payload jsonb,
  expires_at timestamptz,
  owner uuid,
  lease_until timestamptz,
  retry_at timestamptz,
  CHECK ((payload IS NULL) = (expires_at IS NULL)),
  CHECK ((owner IS NULL) = (lease_until IS NULL)),
  CHECK (payload IS NULL OR (jsonb_typeof(payload->'transcript') = 'array'
    AND jsonb_array_length(payload->'transcript') > 0 AND payload->'isPartial' = 'false'::jsonb) IS TRUE)
);
ALTER TABLE public.transcript_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transcript_cache FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.transcript_cache TO transcript_cache_executor;
CREATE POLICY transcript_cache_access ON public.transcript_cache TO transcript_cache_executor USING (true) WITH CHECK (true);

-- Strict canonical input prevents alternate spellings from bypassing coordination.
-- Matches supadataNativeCacheIdentity(videoId, requestedLanguage?.toLowerCase()).
CREATE FUNCTION public.transcript_cache_validate_key(p_key text)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF p_key IS NULL OR length(p_key) > 512 OR p_key !~ '^\["supadata","native","v1","[A-Za-z0-9_-]{11}",(null|"[a-z]{2,3}(-[a-z0-9]{2,8})*")\]$' THEN
    RAISE EXCEPTION 'Invalid canonical transcript cache key' USING ERRCODE = '22023';
  END IF;
END $$;

CREATE FUNCTION public.transcript_cache_acquire(p_key text, p_refresh boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE entry public.transcript_cache%ROWTYPE; now_value timestamptz; owner_value uuid;
BEGIN
  PERFORM public.transcript_cache_validate_key(p_key);
  IF p_refresh IS NULL THEN RAISE EXCEPTION 'Missing refresh decision' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('transcript-cache:' || p_key, 0));
  now_value := clock_timestamp();
  SELECT * INTO entry FROM public.transcript_cache WHERE key = p_key;
  IF NOT p_refresh AND entry.expires_at > now_value THEN
    RETURN jsonb_build_object('state', 'hit', 'payload', entry.payload);
  END IF;
  IF entry.retry_at > now_value THEN
    RETURN jsonb_build_object('state', 'waiting', 'retry_at', entry.retry_at);
  END IF;
  owner_value := gen_random_uuid();
  INSERT INTO public.transcript_cache(key, owner, lease_until, retry_at)
    VALUES (p_key, owner_value, now_value + interval '60 seconds', now_value + interval '11 minutes')
    ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner,
      lease_until = EXCLUDED.lease_until, retry_at = EXCLUDED.retry_at;
  RETURN jsonb_build_object('state', 'leader', 'owner', owner_value);
END $$;

-- Check immediately before vendor admission/dispatch; this does not renew the lease.
CREATE FUNCTION public.transcript_cache_assert_owner(p_key text, p_owner uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.transcript_cache_validate_key(p_key);
  PERFORM pg_advisory_xact_lock(hashtextextended('transcript-cache:' || p_key, 0));
  RETURN EXISTS (SELECT FROM public.transcript_cache
    WHERE key = p_key AND owner = p_owner AND lease_until > clock_timestamp());
END $$;

CREATE FUNCTION public.transcript_cache_finish(p_key text, p_owner uuid, p_payload jsonb, p_uncertain boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE entry public.transcript_cache%ROWTYPE; now_value timestamptz; reusable boolean := false;
BEGIN
  PERFORM public.transcript_cache_validate_key(p_key);
  IF p_uncertain IS NULL THEN RAISE EXCEPTION 'Missing outcome' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('transcript-cache:' || p_key, 0));
  now_value := clock_timestamp();
  SELECT * INTO entry FROM public.transcript_cache WHERE key = p_key;
  IF entry.owner IS NULL OR p_owner IS NULL OR entry.owner <> p_owner OR entry.lease_until <= now_value THEN
    RETURN false;
  END IF;
  -- Invalid/incomplete payloads finish as failures, never as reusable success.
  IF NOT p_uncertain AND jsonb_typeof(p_payload->'transcript') = 'array' THEN
    reusable := jsonb_array_length(p_payload->'transcript') > 0 AND p_payload->'isPartial' = 'false'::jsonb;
  END IF;
  UPDATE public.transcript_cache SET
    payload = CASE WHEN reusable THEN p_payload ELSE payload END,
    expires_at = CASE WHEN reusable THEN now_value + interval '30 days' ELSE expires_at END,
    owner = NULL, lease_until = NULL,
    retry_at = CASE WHEN reusable THEN NULL WHEN p_uncertain THEN now_value + interval '10 minutes'
      ELSE now_value + interval '30 seconds' END
    WHERE key = p_key;
  RETURN true;
END $$;

CREATE FUNCTION public.transcript_cache_read(p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE entry public.transcript_cache%ROWTYPE; now_value timestamptz;
BEGIN
  PERFORM public.transcript_cache_validate_key(p_key);
  PERFORM pg_advisory_xact_lock(hashtextextended('transcript-cache:' || p_key, 0));
  now_value := clock_timestamp();
  SELECT * INTO entry FROM public.transcript_cache WHERE key = p_key;
  -- Pollers join refresh work rather than mistaking the prior payload for its result.
  IF entry.owner IS NOT NULL AND entry.retry_at > now_value THEN
    RETURN jsonb_build_object('state', 'waiting', 'retry_at', entry.retry_at);
  END IF;
  IF entry.expires_at > now_value THEN
    RETURN jsonb_build_object('state', 'hit', 'payload', entry.payload);
  END IF;
  IF entry.retry_at > now_value THEN
    RETURN jsonb_build_object('state', 'waiting', 'retry_at', entry.retry_at);
  END IF;
  RETURN jsonb_build_object('state', 'miss');
END $$;

GRANT transcript_cache_executor TO CURRENT_USER WITH SET TRUE, INHERIT TRUE;
GRANT CREATE ON SCHEMA public TO transcript_cache_executor;
ALTER FUNCTION public.transcript_cache_validate_key(text) OWNER TO transcript_cache_executor;
ALTER FUNCTION public.transcript_cache_acquire(text,boolean) OWNER TO transcript_cache_executor;
ALTER FUNCTION public.transcript_cache_assert_owner(text,uuid) OWNER TO transcript_cache_executor;
ALTER FUNCTION public.transcript_cache_finish(text,uuid,jsonb,boolean) OWNER TO transcript_cache_executor;
ALTER FUNCTION public.transcript_cache_read(text) OWNER TO transcript_cache_executor;
REVOKE CREATE ON SCHEMA public FROM transcript_cache_executor;
REVOKE ALL ON FUNCTION public.transcript_cache_validate_key(text), public.transcript_cache_acquire(text,boolean),
  public.transcript_cache_finish(text,uuid,jsonb,boolean), public.transcript_cache_read(text),
  public.transcript_cache_assert_owner(text,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transcript_cache_acquire(text,boolean), public.transcript_cache_finish(text,uuid,jsonb,boolean),
  public.transcript_cache_read(text), public.transcript_cache_assert_owner(text,uuid) TO service_role;
GRANT transcript_cache_executor TO CURRENT_USER WITH SET FALSE, INHERIT FALSE;
COMMIT;
