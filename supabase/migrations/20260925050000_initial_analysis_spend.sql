-- Initial-analysis capabilities and AI attempts extend the server-only spend ledger.
-- They never mutate customer credit tables. Native caption units remain separate.
BEGIN;
CREATE TABLE public.initial_analysis_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id text NOT NULL,
  identifiers text[] NOT NULL,
  tier text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes',
  complete boolean NOT NULL DEFAULT false
);
CREATE TABLE public.initial_analysis_operations (
  flow_id uuid NOT NULL REFERENCES public.initial_analysis_flows(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('transcript','summary','preview','questions','highlights','themes')),
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (flow_id, operation)
);
CREATE TABLE public.initial_ai_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.initial_analysis_flows(id) ON DELETE CASCADE,
  operation text NOT NULL,
  identifiers text[] NOT NULL,
  request_key text NOT NULL,
  counted_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('dispatched','complete','uncertain')),
  lease_until timestamptz NOT NULL,
  blocked_until timestamptz NOT NULL
);
CREATE INDEX initial_ai_time ON public.initial_ai_attempts(counted_at);
CREATE INDEX initial_ai_identity ON public.initial_ai_attempts USING gin(identifiers);
CREATE INDEX initial_ai_key ON public.initial_ai_attempts(request_key, blocked_until);
CREATE INDEX initial_ai_flow ON public.initial_ai_attempts(flow_id, operation);
CREATE INDEX initial_flow_expiry ON public.initial_analysis_flows(expires_at);

ALTER TABLE public.initial_analysis_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.initial_analysis_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.initial_ai_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.initial_analysis_flows, public.initial_analysis_operations, public.initial_ai_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.initial_analysis_flows, public.initial_analysis_operations, public.initial_ai_attempts TO transcript_spend_executor;
CREATE POLICY initial_flows_access ON public.initial_analysis_flows TO transcript_spend_executor USING (true) WITH CHECK (true);
CREATE POLICY initial_operations_access ON public.initial_analysis_operations TO transcript_spend_executor USING (true) WITH CHECK (true);
CREATE POLICY initial_attempts_access ON public.initial_ai_attempts TO transcript_spend_executor USING (true) WITH CHECK (true);

CREATE FUNCTION public.create_initial_analysis_flow(p_video text, p_tier text, p_identifiers text[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result uuid;
BEGIN
  IF p_video IS NULL OR p_video !~ '^[A-Za-z0-9_-]{11}$' OR p_tier IS NULL
    OR p_tier NOT IN ('guest','free','topup','pro','unlimited') OR p_identifiers IS NULL
    OR cardinality(p_identifiers) NOT BETWEEN 1 AND 2
    OR EXISTS (SELECT FROM unnest(p_identifiers) v WHERE v IS NULL OR length(v) NOT BETWEEN 1 AND 256) THEN
    RAISE EXCEPTION 'Invalid flow parameters';
  END IF;
  -- Share guest-record serialization with native transcript admission.
  PERFORM pg_advisory_xact_lock(hashtextextended('transcript-spend:native-v1',0));
  IF p_tier = 'guest' AND EXISTS (SELECT FROM public.guest_analysis_usage WHERE identifier = ANY(p_identifiers)) THEN
    RETURN NULL;
  END IF;
  -- Retention exceeds both rolling windows; bounded cleanup cannot reset live usage.
  DELETE FROM public.initial_analysis_flows WHERE id IN (
    SELECT id FROM public.initial_analysis_flows WHERE expires_at < clock_timestamp()-interval '31 days'
    ORDER BY expires_at LIMIT 100
  );
  INSERT INTO public.initial_analysis_flows(video_id,tier,identifiers) VALUES (p_video,p_tier,p_identifiers) RETURNING id INTO result;
  RETURN result;
END $$;

CREATE FUNCTION public.claim_initial_analysis_operation(p_flow uuid, p_video text, p_identifiers text[], p_operation text, p_tier text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('initial-ai:v1',0));
  IF p_operation IS NULL OR p_operation NOT IN ('transcript','summary','preview','questions','highlights','themes')
    OR p_tier IS NULL OR p_tier NOT IN ('guest','free','topup','pro','unlimited') THEN
    RAISE EXCEPTION 'Invalid operation';
  END IF;
  -- Exact principal binding: an overlapping shared IP is a budget identity, not a capability owner.
  IF NOT EXISTS (SELECT FROM public.initial_analysis_flows WHERE id=p_flow AND video_id=p_video
    AND identifiers=p_identifiers AND NOT complete AND expires_at>clock_timestamp()) THEN RETURN false; END IF;
  INSERT INTO public.initial_analysis_operations(flow_id,operation) VALUES(p_flow,p_operation) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed=1 THEN UPDATE public.initial_analysis_flows SET tier=p_tier WHERE id=p_flow; END IF;
  RETURN changed=1;
END $$;

CREATE FUNCTION public.finish_initial_analysis_operation(p_flow uuid, p_operation text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('initial-ai:v1',0));
  UPDATE public.initial_analysis_operations SET complete=true WHERE flow_id=p_flow AND operation=p_operation AND NOT complete;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF p_operation='highlights' THEN UPDATE public.initial_analysis_flows SET complete=true WHERE id=p_flow; END IF;
  RETURN changed=1;
END $$;

CREATE FUNCTION public.reserve_initial_ai_attempt(p_flow uuid, p_operation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  flow public.initial_analysis_flows%ROWTYPE;
  daily_limit integer; monthly_limit integer; concurrency_limit integer; operation_limit integer;
  now_value timestamptz; retry_time timestamptz; candidate timestamptz; request_key_value text;
  reservation uuid; scope_global boolean; window_size interval; cap integer; usage_count integer;
  reason text := 'budget';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('initial-ai:v1',0));
  now_value := clock_timestamp();
  SELECT * INTO flow FROM public.initial_analysis_flows WHERE id=p_flow AND NOT complete AND expires_at>now_value;
  IF NOT FOUND OR NOT EXISTS (SELECT FROM public.initial_analysis_operations WHERE flow_id=p_flow AND operation=p_operation AND NOT complete) THEN
    RETURN jsonb_build_object('allowed',false,'reason','flow');
  END IF;
  CASE p_operation WHEN 'summary' THEN operation_limit:=2; WHEN 'preview' THEN operation_limit:=1;
    WHEN 'questions' THEN operation_limit:=1; WHEN 'highlights' THEN operation_limit:=6; WHEN 'themes' THEN operation_limit:=2;
    ELSE RAISE EXCEPTION 'Invalid AI operation'; END CASE;
  IF (SELECT count(*) FROM public.initial_ai_attempts WHERE flow_id=p_flow AND operation=p_operation)>=operation_limit
    OR (SELECT count(*) FROM public.initial_ai_attempts WHERE flow_id=p_flow)>=12 THEN
    RETURN jsonb_build_object('allowed',false,'reason','operation');
  END IF;
  CASE flow.tier WHEN 'guest' THEN daily_limit:=12; monthly_limit:=36; concurrency_limit:=2;
    WHEN 'free' THEN daily_limit:=36; monthly_limit:=180; concurrency_limit:=2;
    WHEN 'topup','pro' THEN daily_limit:=180; monthly_limit:=1800; concurrency_limit:=4;
    WHEN 'unlimited' THEN daily_limit:=360; monthly_limit:=3600; concurrency_limit:=4;
    ELSE RAISE EXCEPTION 'Invalid AI tier'; END CASE;
  request_key_value:=flow.video_id||':'||p_operation;
  SELECT max(blocked_until) INTO retry_time FROM public.initial_ai_attempts
    WHERE request_key=request_key_value AND blocked_until>now_value
      AND (state='uncertain' OR flow_id<>p_flow);
  IF retry_time IS NOT NULL THEN reason:='cooldown'; END IF;
  FOREACH scope_global IN ARRAY ARRAY[false,true] LOOP
    FOREACH window_size IN ARRAY ARRAY[interval '24 hours',interval '30 days'] LOOP
      cap:=CASE WHEN scope_global THEN CASE WHEN window_size=interval '24 hours' THEN 1200 ELSE 30000 END
        ELSE CASE WHEN window_size=interval '24 hours' THEN daily_limit ELSE monthly_limit END END;
      SELECT count(*) INTO usage_count FROM public.initial_ai_attempts WHERE counted_at>now_value-window_size
        AND (scope_global OR identifiers && flow.identifiers);
      IF usage_count>=cap THEN
        SELECT counted_at+window_size INTO candidate FROM public.initial_ai_attempts WHERE counted_at>now_value-window_size
          AND (scope_global OR identifiers && flow.identifiers) ORDER BY counted_at OFFSET (usage_count-cap) LIMIT 1;
        IF retry_time IS NULL OR candidate>retry_time THEN retry_time:=candidate; reason:='budget'; END IF;
      END IF;
    END LOOP;
    cap:=CASE WHEN scope_global THEN 20 ELSE concurrency_limit END;
    SELECT count(*) INTO usage_count FROM public.initial_ai_attempts WHERE state IN ('dispatched','uncertain') AND lease_until>now_value
      AND (scope_global OR identifiers && flow.identifiers);
    IF usage_count>=cap THEN
      SELECT lease_until INTO candidate FROM public.initial_ai_attempts WHERE state IN ('dispatched','uncertain') AND lease_until>now_value
        AND (scope_global OR identifiers && flow.identifiers) ORDER BY lease_until OFFSET (usage_count-cap) LIMIT 1;
      IF retry_time IS NULL OR candidate>retry_time THEN retry_time:=candidate; reason:='concurrency'; END IF;
    END IF;
  END LOOP;
  IF retry_time IS NOT NULL THEN RETURN jsonb_build_object('allowed',false,'reason',reason,'retry_at',retry_time); END IF;
  -- Lost acknowledgement never permits dispatch. Its conservatively retained unit is not refunded.
  INSERT INTO public.initial_ai_attempts(flow_id,operation,identifiers,request_key,counted_at,state,lease_until,blocked_until)
    VALUES(p_flow,p_operation,flow.identifiers,request_key_value,now_value,'dispatched',now_value+interval '10 minutes',now_value+interval '10 minutes')
    RETURNING id INTO reservation;
  RETURN jsonb_build_object('allowed',true,'reservation_id',reservation);
END $$;

CREATE FUNCTION public.finish_initial_ai_attempt(p_id uuid, p_uncertain boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer; now_value timestamptz;
BEGIN
  IF p_uncertain IS NULL THEN RAISE EXCEPTION 'Missing outcome'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('initial-ai:v1',0));
  now_value:=clock_timestamp();
  UPDATE public.initial_ai_attempts SET state=CASE WHEN p_uncertain THEN 'uncertain' ELSE 'complete' END,
    lease_until=CASE WHEN p_uncertain THEN now_value+interval '10 minutes' ELSE now_value END,
    blocked_until=CASE WHEN p_uncertain THEN now_value+interval '10 minutes' ELSE now_value END
    WHERE id=p_id AND state='dispatched';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed=1;
END $$;

GRANT transcript_spend_executor TO CURRENT_USER WITH SET TRUE, INHERIT TRUE;
GRANT CREATE ON SCHEMA public TO transcript_spend_executor;
ALTER FUNCTION public.create_initial_analysis_flow(text,text,text[]) OWNER TO transcript_spend_executor;
ALTER FUNCTION public.claim_initial_analysis_operation(uuid,text,text[],text,text) OWNER TO transcript_spend_executor;
ALTER FUNCTION public.finish_initial_analysis_operation(uuid,text) OWNER TO transcript_spend_executor;
ALTER FUNCTION public.reserve_initial_ai_attempt(uuid,text) OWNER TO transcript_spend_executor;
ALTER FUNCTION public.finish_initial_ai_attempt(uuid,boolean) OWNER TO transcript_spend_executor;
REVOKE CREATE ON SCHEMA public FROM transcript_spend_executor;
REVOKE ALL ON FUNCTION public.create_initial_analysis_flow(text,text,text[]), public.claim_initial_analysis_operation(uuid,text,text[],text,text),
  public.finish_initial_analysis_operation(uuid,text), public.reserve_initial_ai_attempt(uuid,text), public.finish_initial_ai_attempt(uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_initial_analysis_flow(text,text,text[]), public.claim_initial_analysis_operation(uuid,text,text[],text,text),
  public.finish_initial_analysis_operation(uuid,text), public.reserve_initial_ai_attempt(uuid,text), public.finish_initial_ai_attempt(uuid,boolean) TO service_role;
GRANT transcript_spend_executor TO CURRENT_USER WITH SET FALSE, INHERIT FALSE;
COMMIT;
