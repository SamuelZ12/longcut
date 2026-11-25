-- Migration: Keep credit and billing writes on the server
-- Purpose:
--   1. Top-up credits are only added by the Stripe flow, which uses the service role.
--   2. The credit-consuming RPCs only act on the signed-in user's own account.
--      Function bodies below are unchanged from their latest migrations
--      (20251101120000, 20260121120000, 20251123090000); the only addition is
--      the caller check at the top.
--   3. Billing columns on profiles can only be changed by the server.
--   4. upsert_video_analysis_with_user_link was replaced by the server-only
--      insert_video_analysis_server (20251214185226); clients can no longer call it.
--   5. audit_logs rows written with a user session must belong to that user
--      (or have no user, as for signed-out security events).

-- -----------------------------------------------------------------------------
-- 1. increment_topup_credits: server only
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.increment_topup_credits(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_topup_credits(uuid, integer) TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Credit consumption: caller must be the user (or the service role)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_topup_credit(
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated integer;
BEGIN
  -- Only the signed-in owner (or the server) may use this user's credits
  IF COALESCE(auth.role(), '') <> 'service_role' AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not allowed to use credits for another user' USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
  SET topup_credits = topup_credits - 1
  WHERE id = p_user_id
    AND topup_credits > 0;

  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION consume_video_credit_atomically(
  p_user_id uuid,
  p_youtube_id text,
  p_identifier text,
  p_subscription_tier text,
  p_base_limit integer,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_video_id uuid DEFAULT NULL,
  p_counted boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_counted_usage integer;
  v_topup_credits integer;
  v_base_remaining integer;
  v_total_remaining integer;
  v_generation_id uuid;
  v_used_topup boolean := false;
  v_existing_generation_id uuid;
BEGIN
  -- Only the signed-in owner (or the server) may use this user's credits
  IF COALESCE(auth.role(), '') <> 'service_role' AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not allowed to use credits for another user' USING ERRCODE = '42501';
  END IF;

  -- Lock the user's profile row for update to prevent concurrent modifications
  SELECT topup_credits
  INTO v_topup_credits
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'NO_SUBSCRIPTION',
      'error', 'Profile not found'
    );
  END IF;

  -- NEW: Check for existing generation record for this video in this period
  -- This prevents double-charging when user refreshes during AI generation
  IF p_counted THEN
    SELECT id INTO v_existing_generation_id
    FROM video_generations
    WHERE user_id = p_user_id
      AND youtube_id = p_youtube_id
      AND created_at >= p_period_start
      AND created_at <= p_period_end
      AND counted_toward_limit = true
    LIMIT 1;

    IF v_existing_generation_id IS NOT NULL THEN
      -- Already charged for this video in this period - return success without charging again
      -- Recalculate current remaining credits for accurate response
      SELECT COUNT(*)
      INTO v_counted_usage
      FROM video_generations
      WHERE user_id = p_user_id
        AND created_at >= p_period_start
        AND created_at <= p_period_end
        AND counted_toward_limit = true;

      v_base_remaining := GREATEST(0, p_base_limit - v_counted_usage);
      v_total_remaining := v_base_remaining + v_topup_credits;

      RETURN jsonb_build_object(
        'allowed', true,
        'reason', 'ALREADY_COUNTED',
        'generation_id', v_existing_generation_id,
        'used_topup', false,
        'deduplicated', true,
        'base_remaining', v_base_remaining,
        'topup_remaining', v_topup_credits,
        'total_remaining', v_total_remaining
      );
    END IF;
  END IF;

  -- Count usage in the current period (excluding cached videos)
  SELECT COUNT(*)
  INTO v_counted_usage
  FROM video_generations
  WHERE user_id = p_user_id
    AND created_at >= p_period_start
    AND created_at <= p_period_end
    AND counted_toward_limit = true;

  -- Calculate remaining credits
  v_base_remaining := GREATEST(0, p_base_limit - v_counted_usage);
  v_total_remaining := v_base_remaining + v_topup_credits;

  -- Check if user has reached limit
  IF p_counted AND v_total_remaining <= 0 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'LIMIT_REACHED',
      'base_remaining', v_base_remaining,
      'topup_remaining', v_topup_credits,
      'total_remaining', v_total_remaining
    );
  END IF;

  -- Insert video generation record
  INSERT INTO video_generations (
    user_id,
    identifier,
    youtube_id,
    video_id,
    counted_toward_limit,
    subscription_tier
  ) VALUES (
    p_user_id,
    p_identifier,
    p_youtube_id,
    p_video_id,
    p_counted,
    p_subscription_tier
  )
  RETURNING id INTO v_generation_id;

  -- If this generation counts toward limit, consume credit
  IF p_counted THEN
    -- If base credits exhausted, consume top-up credit
    IF v_base_remaining <= 0 AND v_topup_credits > 0 THEN
      UPDATE profiles
      SET topup_credits = topup_credits - 1
      WHERE id = p_user_id
        AND topup_credits > 0;

      IF FOUND THEN
        v_used_topup := true;
        v_topup_credits := v_topup_credits - 1;
      END IF;
    END IF;
  END IF;

  -- Return success with updated values
  RETURN jsonb_build_object(
    'allowed', true,
    'reason', 'OK',
    'generation_id', v_generation_id,
    'used_topup', v_used_topup,
    'deduplicated', false,
    'base_remaining', GREATEST(0, v_base_remaining - (CASE WHEN p_counted AND NOT v_used_topup THEN 1 ELSE 0 END)),
    'topup_remaining', v_topup_credits,
    'total_remaining', v_total_remaining - (CASE WHEN p_counted THEN 1 ELSE 0 END)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_image_credit_atomically(
  p_user_id uuid,
  p_youtube_id text,
  p_subscription_tier text,
  p_base_limit integer,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_video_id uuid DEFAULT NULL,
  p_counted boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_counted_usage integer;
  v_base_remaining integer;
  v_generation_id uuid;
BEGIN
  -- Only the signed-in owner (or the server) may use this user's credits
  IF COALESCE(auth.role(), '') <> 'service_role' AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not allowed to use credits for another user' USING ERRCODE = '42501';
  END IF;

  -- Lock the profile row to avoid race conditions
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'NO_SUBSCRIPTION',
      'error', 'Profile not found'
    );
  END IF;

  -- Count counted generations within current window
  SELECT COUNT(*) INTO v_counted_usage
  FROM public.image_generations
  WHERE user_id = p_user_id
    AND created_at >= p_period_start
    AND created_at < p_period_end
    AND counted_toward_limit = true;

  v_base_remaining := GREATEST(0, p_base_limit - v_counted_usage);

  IF p_counted AND v_base_remaining <= 0 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'LIMIT_REACHED',
      'base_remaining', v_base_remaining
    );
  END IF;

  INSERT INTO public.image_generations (
    user_id,
    youtube_id,
    video_id,
    counted_toward_limit,
    subscription_tier
  ) VALUES (
    p_user_id,
    p_youtube_id,
    p_video_id,
    p_counted,
    p_subscription_tier
  )
  RETURNING id INTO v_generation_id;

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', 'OK',
    'generation_id', v_generation_id,
    'base_remaining', CASE
      WHEN p_counted THEN GREATEST(0, v_base_remaining - 1)
      ELSE v_base_remaining
    END
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. profiles: billing columns are written by the server only
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_profile_billing_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- SECURITY INVOKER: current_user is the API role for direct client updates,
  -- and the function owner inside SECURITY DEFINER credit functions.
  IF current_user IN ('anon', 'authenticated') AND (
       NEW.topup_credits IS DISTINCT FROM OLD.topup_credits
    OR NEW.subscription_tier IS DISTINCT FROM OLD.subscription_tier
    OR NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
    OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
    OR NEW.subscription_current_period_start IS DISTINCT FROM OLD.subscription_current_period_start
    OR NEW.subscription_current_period_end IS DISTINCT FROM OLD.subscription_current_period_end
    OR NEW.cancel_at_period_end IS DISTINCT FROM OLD.cancel_at_period_end
  ) THEN
    RAISE EXCEPTION 'Billing fields can only be changed by the server' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_billing_columns ON public.profiles;
CREATE TRIGGER protect_profile_billing_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_billing_columns();

-- -----------------------------------------------------------------------------
-- 4. Legacy upsert_video_analysis_with_user_link: no client access
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.upsert_video_analysis_with_user_link(
  text, text, text, integer, text, jsonb, jsonb, jsonb, jsonb, text, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  -- Older overload from the initial schema, if it is still present
  IF to_regprocedure('public.upsert_video_analysis_with_user_link(text, text, text, integer, text, jsonb, jsonb, jsonb, jsonb, text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.upsert_video_analysis_with_user_link(
      text, text, text, integer, text, jsonb, jsonb, jsonb, jsonb, text, uuid
    ) FROM PUBLIC, anon, authenticated;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5. audit_logs: session inserts may only log for the signed-in user
-- -----------------------------------------------------------------------------
ALTER POLICY audit_logs_insert_service ON public.audit_logs
  WITH CHECK (user_id IS NULL OR user_id = auth.uid());
