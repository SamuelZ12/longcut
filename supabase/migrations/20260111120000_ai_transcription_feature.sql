-- Migration: AI Transcription Feature
-- Created: 2026-01-11
-- Purpose: Add tables and functions for AI-powered transcription (Pro feature)

-- =====================================================
-- Add transcription_minutes_topup to profiles
-- =====================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS transcription_minutes_topup integer;

ALTER TABLE public.profiles
  ALTER COLUMN transcription_minutes_topup SET DEFAULT 0;

UPDATE public.profiles
SET transcription_minutes_topup = 0
WHERE transcription_minutes_topup IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'profiles_transcription_minutes_topup_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_transcription_minutes_topup_check
      CHECK (transcription_minutes_topup >= 0);
  END IF;
END
$$;

ALTER TABLE public.profiles
  ALTER COLUMN transcription_minutes_topup SET NOT NULL;

-- =====================================================
-- Create transcription_jobs table
-- Tracks individual transcription job status and results
-- =====================================================
CREATE TABLE IF NOT EXISTS public.transcription_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  video_id uuid REFERENCES public.video_analyses (id) ON DELETE SET NULL,
  youtube_id text NOT NULL,

  -- Job status
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'downloading', 'transcribing', 'completed', 'failed', 'cancelled')),
  error_message text,

  -- Timing and cost
  duration_seconds integer,
  estimated_cost_cents integer,

  -- Progress tracking (0-100)
  progress integer DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  current_stage text,

  -- Audio storage
  audio_storage_path text,

  -- Resulting transcript (stored as JSON array of segments)
  transcript_data jsonb,

  -- Chunking info for long videos
  total_chunks integer DEFAULT 1,
  completed_chunks integer DEFAULT 0,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_transcription_jobs_user_id
  ON public.transcription_jobs (user_id);

CREATE INDEX IF NOT EXISTS idx_transcription_jobs_youtube_id
  ON public.transcription_jobs (youtube_id);

CREATE INDEX IF NOT EXISTS idx_transcription_jobs_status
  ON public.transcription_jobs (status);

CREATE INDEX IF NOT EXISTS idx_transcription_jobs_user_status
  ON public.transcription_jobs (user_id, status);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_transcription_job_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_transcription_jobs_updated_at ON public.transcription_jobs;
CREATE TRIGGER trigger_transcription_jobs_updated_at
  BEFORE UPDATE ON public.transcription_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_transcription_job_updated_at();

-- =====================================================
-- Create transcription_usage table
-- Tracks usage of transcription minutes
-- =====================================================
CREATE TABLE IF NOT EXISTS public.transcription_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.transcription_jobs (id) ON DELETE CASCADE,

  -- Usage tracking
  minutes_used integer NOT NULL CHECK (minutes_used > 0),
  source text NOT NULL CHECK (source IN ('subscription', 'topup')),

  -- Period tracking (for subscription credits)
  period_start timestamptz,
  period_end timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcription_usage_user_id
  ON public.transcription_usage (user_id);

CREATE INDEX IF NOT EXISTS idx_transcription_usage_job_id
  ON public.transcription_usage (job_id);

CREATE INDEX IF NOT EXISTS idx_transcription_usage_period
  ON public.transcription_usage (user_id, period_start, period_end);

-- =====================================================
-- Create transcription_topup_purchases table
-- Record Stripe top-up purchases for transcription minutes
-- =====================================================
CREATE TABLE IF NOT EXISTS public.transcription_topup_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  stripe_payment_intent_id text NOT NULL UNIQUE,
  minutes_purchased integer NOT NULL CHECK (minutes_purchased > 0),
  amount_paid integer NOT NULL CHECK (amount_paid >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcription_topup_purchases_user
  ON public.transcription_topup_purchases (user_id, created_at);

-- =====================================================
-- Function: get_transcription_usage_in_period
-- Purpose: Get total transcription minutes used in a billing period
-- =====================================================
CREATE OR REPLACE FUNCTION get_transcription_usage_in_period(
  p_user_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT COALESCE(SUM(minutes_used), 0)::integer
  FROM public.transcription_usage
  WHERE user_id = p_user_id
    AND source = 'subscription'
    AND period_start = p_period_start
    AND period_end = p_period_end;
$$;

GRANT EXECUTE ON FUNCTION get_transcription_usage_in_period TO authenticated;
GRANT EXECUTE ON FUNCTION get_transcription_usage_in_period TO service_role;

-- =====================================================
-- Function: check_transcription_minutes_available
-- Purpose: Pre-flight check for available transcription minutes
-- =====================================================
CREATE OR REPLACE FUNCTION check_transcription_minutes_available(
  p_user_id uuid,
  p_minutes_needed integer,
  p_subscription_limit integer,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_subscription_tier text;
  v_used_subscription integer;
  v_topup_minutes integer;
  v_subscription_remaining integer;
  v_total_remaining integer;
BEGIN
  -- Get user's subscription tier and topup balance
  SELECT subscription_tier, transcription_minutes_topup
  INTO v_subscription_tier, v_topup_minutes
  FROM profiles
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'NO_PROFILE',
      'subscription_remaining', 0,
      'topup_remaining', 0,
      'total_remaining', 0
    );
  END IF;

  -- Check if user has Pro subscription
  IF v_subscription_tier != 'pro' THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'NOT_PRO',
      'subscription_tier', v_subscription_tier,
      'subscription_remaining', 0,
      'topup_remaining', 0,
      'total_remaining', 0
    );
  END IF;

  -- Get usage in current period
  v_used_subscription := get_transcription_usage_in_period(p_user_id, p_period_start, p_period_end);
  v_subscription_remaining := GREATEST(0, p_subscription_limit - v_used_subscription);
  v_total_remaining := v_subscription_remaining + v_topup_minutes;

  RETURN jsonb_build_object(
    'allowed', v_total_remaining >= p_minutes_needed,
    'reason', CASE
      WHEN v_total_remaining >= p_minutes_needed THEN 'OK'
      ELSE 'INSUFFICIENT_CREDITS'
    END,
    'subscription_remaining', v_subscription_remaining,
    'topup_remaining', v_topup_minutes,
    'total_remaining', v_total_remaining,
    'minutes_needed', p_minutes_needed,
    'will_use_topup', v_subscription_remaining < p_minutes_needed AND v_topup_minutes > 0
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_transcription_minutes_available TO authenticated;
GRANT EXECUTE ON FUNCTION check_transcription_minutes_available TO service_role;

-- =====================================================
-- Function: consume_transcription_minutes_atomically
-- Purpose: Atomically reserve transcription minutes for a job
-- =====================================================
CREATE OR REPLACE FUNCTION consume_transcription_minutes_atomically(
  p_user_id uuid,
  p_job_id uuid,
  p_minutes integer,
  p_subscription_limit integer,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_subscription_tier text;
  v_topup_minutes integer;
  v_used_subscription integer;
  v_subscription_remaining integer;
  v_source text;
  v_minutes_from_subscription integer;
  v_minutes_from_topup integer;
BEGIN
  -- Lock the profile row
  SELECT subscription_tier, transcription_minutes_topup
  INTO v_subscription_tier, v_topup_minutes
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'NO_PROFILE'
    );
  END IF;

  -- Check Pro subscription
  IF v_subscription_tier != 'pro' THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'NOT_PRO'
    );
  END IF;

  -- Get current period usage
  v_used_subscription := get_transcription_usage_in_period(p_user_id, p_period_start, p_period_end);
  v_subscription_remaining := GREATEST(0, p_subscription_limit - v_used_subscription);

  -- Calculate how to split the consumption
  IF v_subscription_remaining >= p_minutes THEN
    -- All from subscription
    v_minutes_from_subscription := p_minutes;
    v_minutes_from_topup := 0;
    v_source := 'subscription';
  ELSIF v_subscription_remaining + v_topup_minutes >= p_minutes THEN
    -- Mix of subscription and topup
    v_minutes_from_subscription := v_subscription_remaining;
    v_minutes_from_topup := p_minutes - v_subscription_remaining;
    v_source := CASE WHEN v_minutes_from_subscription > 0 THEN 'subscription' ELSE 'topup' END;
  ELSE
    -- Not enough credits
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'INSUFFICIENT_CREDITS',
      'subscription_remaining', v_subscription_remaining,
      'topup_remaining', v_topup_minutes,
      'total_remaining', v_subscription_remaining + v_topup_minutes,
      'minutes_needed', p_minutes
    );
  END IF;

  -- Record subscription usage if any
  IF v_minutes_from_subscription > 0 THEN
    INSERT INTO transcription_usage (user_id, job_id, minutes_used, source, period_start, period_end)
    VALUES (p_user_id, p_job_id, v_minutes_from_subscription, 'subscription', p_period_start, p_period_end);
  END IF;

  -- Record topup usage and decrement balance if any
  IF v_minutes_from_topup > 0 THEN
    INSERT INTO transcription_usage (user_id, job_id, minutes_used, source, period_start, period_end)
    VALUES (p_user_id, p_job_id, v_minutes_from_topup, 'topup', p_period_start, p_period_end);

    UPDATE profiles
    SET transcription_minutes_topup = transcription_minutes_topup - v_minutes_from_topup
    WHERE id = p_user_id;

    v_topup_minutes := v_topup_minutes - v_minutes_from_topup;
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', 'OK',
    'minutes_from_subscription', v_minutes_from_subscription,
    'minutes_from_topup', v_minutes_from_topup,
    'subscription_remaining', v_subscription_remaining - v_minutes_from_subscription,
    'topup_remaining', v_topup_minutes
  );
END;
$$;

GRANT EXECUTE ON FUNCTION consume_transcription_minutes_atomically TO authenticated;
GRANT EXECUTE ON FUNCTION consume_transcription_minutes_atomically TO service_role;

-- =====================================================
-- Function: refund_transcription_minutes
-- Purpose: Refund minutes for failed/cancelled jobs
-- =====================================================
CREATE OR REPLACE FUNCTION refund_transcription_minutes(
  p_job_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_usage RECORD;
  v_total_refunded integer := 0;
BEGIN
  -- Get all usage records for this job
  FOR v_usage IN
    SELECT user_id, minutes_used, source
    FROM transcription_usage
    WHERE job_id = p_job_id
  LOOP
    -- Refund topup minutes back to balance
    IF v_usage.source = 'topup' THEN
      UPDATE profiles
      SET transcription_minutes_topup = transcription_minutes_topup + v_usage.minutes_used
      WHERE id = v_usage.user_id;
    END IF;
    -- Note: subscription minutes are not refunded, they just don't count anymore

    v_total_refunded := v_total_refunded + v_usage.minutes_used;
  END LOOP;

  -- Delete usage records
  DELETE FROM transcription_usage WHERE job_id = p_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'minutes_refunded', v_total_refunded
  );
END;
$$;

GRANT EXECUTE ON FUNCTION refund_transcription_minutes TO authenticated;
GRANT EXECUTE ON FUNCTION refund_transcription_minutes TO service_role;

-- =====================================================
-- Function: add_transcription_topup_credits
-- Purpose: Add purchased transcription minutes to user balance
-- =====================================================
CREATE OR REPLACE FUNCTION add_transcription_topup_credits(
  p_user_id uuid,
  p_stripe_payment_intent_id text,
  p_minutes integer,
  p_amount_paid integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_balance integer;
BEGIN
  -- Check if already processed (idempotency)
  IF EXISTS (
    SELECT 1 FROM transcription_topup_purchases
    WHERE stripe_payment_intent_id = p_stripe_payment_intent_id
  ) THEN
    SELECT transcription_minutes_topup INTO v_new_balance
    FROM profiles WHERE id = p_user_id;

    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'new_balance', v_new_balance
    );
  END IF;

  -- Record the purchase
  INSERT INTO transcription_topup_purchases (user_id, stripe_payment_intent_id, minutes_purchased, amount_paid)
  VALUES (p_user_id, p_stripe_payment_intent_id, p_minutes, p_amount_paid);

  -- Add credits to balance
  UPDATE profiles
  SET transcription_minutes_topup = transcription_minutes_topup + p_minutes
  WHERE id = p_user_id
  RETURNING transcription_minutes_topup INTO v_new_balance;

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'minutes_added', p_minutes,
    'new_balance', v_new_balance
  );
END;
$$;

GRANT EXECUTE ON FUNCTION add_transcription_topup_credits TO service_role;

-- =====================================================
-- RLS Policies
-- =====================================================

-- Enable RLS on new tables
ALTER TABLE public.transcription_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_topup_purchases ENABLE ROW LEVEL SECURITY;

-- transcription_jobs policies
CREATE POLICY "Users can view their own transcription jobs"
  ON public.transcription_jobs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own transcription jobs"
  ON public.transcription_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own transcription jobs"
  ON public.transcription_jobs
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role has full access to transcription jobs"
  ON public.transcription_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- transcription_usage policies
CREATE POLICY "Users can view their own transcription usage"
  ON public.transcription_usage
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role has full access to transcription usage"
  ON public.transcription_usage
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- transcription_topup_purchases policies
CREATE POLICY "Users can view their own transcription purchases"
  ON public.transcription_topup_purchases
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role has full access to transcription purchases"
  ON public.transcription_topup_purchases
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =====================================================
-- Comments
-- =====================================================
COMMENT ON TABLE public.transcription_jobs IS 'Tracks AI transcription job status and results for Pro users';
COMMENT ON TABLE public.transcription_usage IS 'Records consumption of transcription minutes (subscription or topup)';
COMMENT ON TABLE public.transcription_topup_purchases IS 'Audit trail for Stripe transcription minute purchases';
COMMENT ON COLUMN public.profiles.transcription_minutes_topup IS 'Balance of purchased transcription minutes (never expires)';
