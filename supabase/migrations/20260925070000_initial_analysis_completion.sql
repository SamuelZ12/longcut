-- Close admission when highlights finish, but drain already claimed operations.
-- Existing expiry, attempt ceilings, rolling budgets, and uncertainty leases remain intact.
BEGIN;
GRANT transcript_spend_executor TO CURRENT_USER WITH SET TRUE, INHERIT TRUE;

-- A draining flow is closed to new transcript cache elections as well as claims.
CREATE OR REPLACE FUNCTION public.validate_initial_analysis_flow(p_flow uuid, p_video text, p_identifiers text[])
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT FROM public.initial_analysis_flows
    WHERE id = p_flow AND video_id = p_video AND identifiers = p_identifiers
      AND NOT complete AND expires_at > clock_timestamp()
      AND NOT EXISTS (SELECT FROM public.initial_analysis_operations
        WHERE flow_id = p_flow AND (operation = 'transcript' OR (operation = 'highlights' AND complete))));
$$;

CREATE OR REPLACE FUNCTION public.claim_initial_analysis_operation(p_flow uuid, p_video text, p_identifiers text[], p_operation text, p_tier text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('initial-ai:v1',0));
  IF p_operation IS NULL OR p_operation NOT IN ('transcript','summary','preview','questions','highlights','themes')
    OR p_tier IS NULL OR p_tier NOT IN ('guest','free','topup','pro','unlimited') THEN
    RAISE EXCEPTION 'Invalid operation';
  END IF;
  IF NOT EXISTS (SELECT FROM public.initial_analysis_flows WHERE id=p_flow AND video_id=p_video
    AND identifiers=p_identifiers AND NOT complete AND expires_at>clock_timestamp())
    OR EXISTS (SELECT FROM public.initial_analysis_operations WHERE flow_id=p_flow AND operation='highlights' AND complete)
    THEN RETURN false; END IF;
  INSERT INTO public.initial_analysis_operations(flow_id,operation) VALUES(p_flow,p_operation) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed=1 THEN UPDATE public.initial_analysis_flows SET tier=p_tier WHERE id=p_flow; END IF;
  RETURN changed=1;
END $$;

CREATE OR REPLACE FUNCTION public.finish_initial_analysis_operation(p_flow uuid, p_operation text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('initial-ai:v1',0));
  UPDATE public.initial_analysis_operations SET complete=true WHERE flow_id=p_flow AND operation=p_operation AND NOT complete;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF EXISTS (SELECT FROM public.initial_analysis_operations WHERE flow_id=p_flow AND operation='highlights' AND complete)
    AND NOT EXISTS (SELECT FROM public.initial_analysis_operations WHERE flow_id=p_flow AND NOT complete) THEN
    UPDATE public.initial_analysis_flows SET complete=true WHERE id=p_flow;
  END IF;
  RETURN changed=1;
END $$;

GRANT transcript_spend_executor TO CURRENT_USER WITH SET FALSE, INHERIT FALSE;
COMMIT;
