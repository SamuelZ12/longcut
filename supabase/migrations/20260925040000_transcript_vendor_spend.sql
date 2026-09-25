-- Native transcript dispatch accounting is separate from customer video credits.
BEGIN;
CREATE ROLE transcript_spend_executor NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA public TO transcript_spend_executor;

CREATE TABLE public.guest_analysis_usage (
  identifier text PRIMARY KEY,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.guest_analysis_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.guest_analysis_usage FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.guest_analysis_usage TO limiter_executor;
GRANT SELECT ON public.guest_analysis_usage TO transcript_spend_executor;
CREATE POLICY guest_usage_read ON public.guest_analysis_usage FOR SELECT TO limiter_executor, transcript_spend_executor USING (true);
CREATE POLICY guest_usage_insert ON public.guest_analysis_usage FOR INSERT TO limiter_executor WITH CHECK (true);

GRANT limiter_executor TO CURRENT_USER WITH SET TRUE, INHERIT TRUE;
-- CREATE TRIGGER waits for existing writers. Old function invocations that resume
-- after this transaction commits still write through this bridge, closing the
-- backfill/read-cutover gap without requiring a production traffic pause.
CREATE FUNCTION public.preserve_legacy_guest_usage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.guest_analysis_usage(identifier, used_at)
    VALUES (NEW.identifier, NEW.timestamp) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
GRANT CREATE ON SCHEMA public TO limiter_executor;
ALTER FUNCTION public.preserve_legacy_guest_usage() OWNER TO limiter_executor;
REVOKE CREATE ON SCHEMA public FROM limiter_executor;
REVOKE ALL ON FUNCTION public.preserve_legacy_guest_usage() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER preserve_legacy_guest_usage AFTER INSERT ON public.rate_limits
  FOR EACH ROW WHEN (NEW.key = 'guest-analysis') EXECUTE FUNCTION public.preserve_legacy_guest_usage();
INSERT INTO public.guest_analysis_usage(identifier, used_at)
  SELECT identifier, min(timestamp) FROM public.rate_limits WHERE key = 'guest-analysis' GROUP BY identifier
  ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.guest_usage_server(p_identifiers text[], p_record boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE identifier_value text;
BEGIN
  IF cardinality(p_identifiers) NOT BETWEEN 1 AND 2 OR p_identifiers IS NULL OR p_record IS NULL THEN
    RAISE EXCEPTION 'Invalid guest identifiers';
  END IF;
  -- Same serialization point as spend admission; guest-use writes cannot race admission.
  PERFORM pg_advisory_xact_lock(hashtextextended('transcript-spend:native-v1', 0));
  FOR identifier_value IN SELECT unnest(p_identifiers) ORDER BY 1 LOOP
    IF identifier_value IS NULL OR length(identifier_value) NOT BETWEEN 1 AND 256 THEN
      RAISE EXCEPTION 'Invalid guest identifier';
    END IF;
  END LOOP;
  IF p_record THEN
    INSERT INTO public.guest_analysis_usage(identifier)
      SELECT DISTINCT value FROM unnest(p_identifiers) AS value ON CONFLICT DO NOTHING;
  END IF;
  RETURN EXISTS (SELECT FROM public.guest_analysis_usage WHERE identifier = ANY(p_identifiers));
END $$;
GRANT limiter_executor TO CURRENT_USER WITH SET FALSE, INHERIT FALSE;

CREATE TABLE public.transcript_spend_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifiers text[] NOT NULL,
  request_key text NOT NULL,
  counted_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'dispatched', 'complete', 'uncertain', 'released')),
  lease_until timestamptz NOT NULL,
  blocked_until timestamptz NOT NULL
);
CREATE INDEX transcript_spend_time ON public.transcript_spend_attempts(counted_at);
CREATE INDEX transcript_spend_key ON public.transcript_spend_attempts(request_key, blocked_until);
CREATE INDEX transcript_spend_identity ON public.transcript_spend_attempts USING gin(identifiers);
ALTER TABLE public.transcript_spend_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transcript_spend_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transcript_spend_attempts TO transcript_spend_executor;
CREATE POLICY transcript_spend_access ON public.transcript_spend_attempts TO transcript_spend_executor USING (true) WITH CHECK (true);

CREATE FUNCTION public.reserve_transcript_spend(p_policy text, p_tier text, p_identifiers text[], p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  daily_limit integer; monthly_limit integer; concurrency_limit integer;
  current_time_value timestamptz; retry_time timestamptz; candidate timestamptz;
  reservation uuid; scope_global boolean; window_size interval; cap integer; usage_count integer;
  reason text := 'budget';
BEGIN
  IF p_policy IS DISTINCT FROM 'native-v1' OR p_tier IS NULL OR p_key IS NULL
    OR length(p_key) NOT BETWEEN 1 AND 512 OR p_identifiers IS NULL
    OR cardinality(p_identifiers) NOT BETWEEN 1 AND 2
    OR EXISTS (SELECT FROM unnest(p_identifiers) v WHERE v IS NULL OR length(v) NOT BETWEEN 1 AND 256) THEN
    RAISE EXCEPTION 'Invalid transcript spend parameters';
  END IF;
  CASE p_tier
    WHEN 'guest' THEN daily_limit := 2; monthly_limit := 6; concurrency_limit := 1;
    WHEN 'free' THEN daily_limit := 5; monthly_limit := 30; concurrency_limit := 1;
    WHEN 'topup', 'pro' THEN daily_limit := 25; monthly_limit := 300; concurrency_limit := 2;
    WHEN 'unlimited' THEN daily_limit := 50; monthly_limit := 600; concurrency_limit := 2;
    ELSE RAISE EXCEPTION 'Invalid transcript tier';
  END CASE;
  -- Single global lock serializes ALL workers and identities across both windows and concurrency.
  PERFORM pg_advisory_xact_lock(hashtextextended('transcript-spend:native-v1', 0));
  current_time_value := clock_timestamp();
  IF p_tier = 'guest' AND EXISTS (SELECT FROM public.guest_analysis_usage WHERE identifier = ANY(p_identifiers)) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'guest_used', 'retry_at', current_time_value);
  END IF;
  SELECT max(blocked_until) INTO retry_time FROM public.transcript_spend_attempts
    WHERE request_key = p_key AND blocked_until > current_time_value AND state <> 'released';
  IF retry_time IS NOT NULL THEN reason := 'cooldown'; END IF;
  FOREACH scope_global IN ARRAY ARRAY[false, true] LOOP
    FOREACH window_size IN ARRAY ARRAY[interval '24 hours', interval '30 days'] LOOP
      cap := CASE WHEN scope_global THEN CASE WHEN window_size = interval '24 hours' THEN 200 ELSE 5000 END
        ELSE CASE WHEN window_size = interval '24 hours' THEN daily_limit ELSE monthly_limit END END;
      SELECT count(*) INTO usage_count FROM public.transcript_spend_attempts
        WHERE state <> 'released' AND counted_at > current_time_value - window_size
          AND (scope_global OR identifiers && p_identifiers);
      IF usage_count >= cap THEN
        -- After a downgrade, more than one attempt may need to expire before admission.
        SELECT counted_at + window_size INTO candidate FROM public.transcript_spend_attempts
          WHERE state <> 'released' AND counted_at > current_time_value - window_size
            AND (scope_global OR identifiers && p_identifiers)
          ORDER BY counted_at OFFSET (usage_count - cap) LIMIT 1;
        IF retry_time IS NULL OR candidate > retry_time THEN retry_time := candidate; reason := 'budget'; END IF;
      END IF;
    END LOOP;
    cap := CASE WHEN scope_global THEN 10 ELSE concurrency_limit END;
    SELECT count(*) INTO usage_count FROM public.transcript_spend_attempts
      WHERE state IN ('reserved', 'dispatched', 'uncertain') AND lease_until > current_time_value
        AND (scope_global OR identifiers && p_identifiers);
    IF usage_count >= cap THEN
      SELECT lease_until INTO candidate FROM public.transcript_spend_attempts
        WHERE state IN ('reserved', 'dispatched', 'uncertain') AND lease_until > current_time_value
          AND (scope_global OR identifiers && p_identifiers)
        ORDER BY lease_until OFFSET (usage_count - cap) LIMIT 1;
      IF retry_time IS NULL OR candidate > retry_time THEN retry_time := candidate; reason := 'concurrency'; END IF;
    END IF;
  END LOOP;
  IF retry_time IS NOT NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', reason, 'retry_at', retry_time);
  END IF;
  -- Abandoned reservations remain counted. Only explicit pre-dispatch release refunds a unit.
  DELETE FROM public.transcript_spend_attempts WHERE id IN (
    SELECT id FROM public.transcript_spend_attempts WHERE counted_at < current_time_value - interval '31 days'
    ORDER BY counted_at LIMIT 100
  );
  INSERT INTO public.transcript_spend_attempts(identifiers, request_key, counted_at, state, lease_until, blocked_until)
    VALUES (p_identifiers, p_key, current_time_value, 'reserved', current_time_value + interval '10 minutes', current_time_value + interval '10 minutes')
    RETURNING id INTO reservation;
  RETURN jsonb_build_object('allowed', true, 'reservation_id', reservation);
END $$;

CREATE FUNCTION public.transition_transcript_spend(p_id uuid, p_action text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE current_time_value timestamptz; changed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('transcript-spend:native-v1', 0));
  current_time_value := clock_timestamp();
  IF p_action = 'release' THEN
    UPDATE public.transcript_spend_attempts SET state = 'released', blocked_until = current_time_value, lease_until = current_time_value
      WHERE id = p_id AND state = 'reserved';
  ELSIF p_action = 'dispatch' THEN
    UPDATE public.transcript_spend_attempts SET state = 'dispatched', counted_at = current_time_value,
      blocked_until = current_time_value + interval '10 minutes', lease_until = current_time_value + interval '10 minutes'
      WHERE id = p_id AND state = 'reserved' AND lease_until > current_time_value;
  ELSIF p_action IN ('complete', 'uncertain') THEN
    UPDATE public.transcript_spend_attempts SET state = p_action,
      blocked_until = CASE WHEN p_action = 'uncertain' THEN current_time_value + interval '10 minutes' ELSE current_time_value END,
      lease_until = CASE WHEN p_action = 'uncertain' THEN current_time_value + interval '10 minutes' ELSE current_time_value END
      WHERE id = p_id AND state = 'dispatched';
  ELSE RAISE EXCEPTION 'Invalid transcript transition';
  END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END $$;

GRANT transcript_spend_executor TO CURRENT_USER WITH SET TRUE, INHERIT TRUE;
GRANT CREATE ON SCHEMA public TO transcript_spend_executor;
ALTER FUNCTION public.reserve_transcript_spend(text, text, text[], text) OWNER TO transcript_spend_executor;
ALTER FUNCTION public.transition_transcript_spend(uuid, text) OWNER TO transcript_spend_executor;
REVOKE CREATE ON SCHEMA public FROM transcript_spend_executor;
REVOKE ALL ON FUNCTION public.reserve_transcript_spend(text, text, text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_transcript_spend(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_transcript_spend(text, text, text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_transcript_spend(uuid, text) TO service_role;
GRANT transcript_spend_executor TO CURRENT_USER WITH SET FALSE, INHERIT FALSE;
COMMIT;
