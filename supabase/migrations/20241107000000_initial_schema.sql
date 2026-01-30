-- ============================================================================
-- Little universe Initial Schema Migration
-- ============================================================================
-- This migration captures the complete database schema including:
-- - Extensions
-- - Tables with constraints and defaults
-- - Indexes for performance
-- - Custom functions
-- - Triggers for automation
-- - Row Level Security (RLS) policies
-- ============================================================================

-- ============================================================================
-- SECTION 1: EXTENSIONS
-- ============================================================================

-- Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";      -- UUID generation functions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";       -- Cryptographic functions
CREATE EXTENSION IF NOT EXISTS "pg_net";         -- Async HTTP requests

-- ============================================================================
-- SECTION 2: TABLES
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Table: profiles
-- Purpose: User profiles with subscription and usage tracking
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email text,
    full_name text,
    avatar_url text,
    free_generations_used integer DEFAULT 0 NOT NULL,
    topic_generation_mode text DEFAULT 'smart'::text NOT NULL,
    stripe_customer_id text,
    subscription_tier text DEFAULT 'free'::text NOT NULL,
    stripe_subscription_id text,
    subscription_status text,
    subscription_current_period_start timestamp with time zone,
    subscription_current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false,
    topup_credits integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT profiles_topic_generation_mode_check CHECK (topic_generation_mode IN ('smart', 'fast')),
    CONSTRAINT profiles_subscription_tier_check CHECK (subscription_tier IN ('free', 'basic', 'premium')),
    CONSTRAINT profiles_topup_credits_check CHECK (topup_credits >= 0)
);

COMMENT ON TABLE public.profiles IS 'User profiles with subscription management and usage tracking';
COMMENT ON COLUMN public.profiles.free_generations_used IS 'Number of free video analyses used';
COMMENT ON COLUMN public.profiles.topic_generation_mode IS 'Preferred AI generation mode: smart (detailed) or fast';
COMMENT ON COLUMN public.profiles.topup_credits IS 'One-time purchase credits for additional analyses';

-- ----------------------------------------------------------------------------
-- Table: video_analyses
-- Purpose: Cached video analysis data with AI-generated content
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.video_analyses (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    youtube_id text UNIQUE NOT NULL,
    title text NOT NULL,
    author text,
    duration integer NOT NULL,
    thumbnail_url text,
    transcript jsonb NOT NULL,
    topics jsonb,
    summary jsonb,
    suggested_questions jsonb,
    model_used text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

COMMENT ON TABLE public.video_analyses IS 'Cached video analysis data with AI-generated highlights and summaries';
COMMENT ON COLUMN public.video_analyses.transcript IS 'Full video transcript with timestamps (JSON array)';
COMMENT ON COLUMN public.video_analyses.topics IS 'AI-generated highlight reels (JSON array)';
COMMENT ON COLUMN public.video_analyses.summary IS 'AI-generated video summary (JSON object)';
COMMENT ON COLUMN public.video_analyses.suggested_questions IS 'AI-generated discussion questions (JSON array)';

-- ----------------------------------------------------------------------------
-- Table: user_videos
-- Purpose: User video history and favorites
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_videos (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    video_id uuid NOT NULL REFERENCES public.video_analyses(id) ON DELETE CASCADE,
    accessed_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    is_favorite boolean DEFAULT false NOT NULL,
    notes text,
    CONSTRAINT user_videos_user_video_unique UNIQUE (user_id, video_id)
);

COMMENT ON TABLE public.user_videos IS 'User video history and favorites';

-- ----------------------------------------------------------------------------
-- Table: user_notes
-- Purpose: User notes on videos with source context
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_notes (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    video_id uuid NOT NULL REFERENCES public.video_analyses(id) ON DELETE CASCADE,
    source text NOT NULL,
    source_id text,
    note_text text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT user_notes_source_check CHECK (source IN ('chat', 'takeaways', 'transcript', 'custom'))
);

COMMENT ON TABLE public.user_notes IS 'User notes with source context (chat, transcript, takeaways, custom)';
COMMENT ON COLUMN public.user_notes.metadata IS 'Additional context about note origin (timestamps, selected text, etc.)';

-- ----------------------------------------------------------------------------
-- Table: rate_limits
-- Purpose: Rate limiting tracking for API endpoints
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limits (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    key text NOT NULL,
    identifier text NOT NULL,
    timestamp timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

COMMENT ON TABLE public.rate_limits IS 'Rate limiting tracking for API endpoints';

-- ----------------------------------------------------------------------------
-- Table: video_generations
-- Purpose: Video generation tracking for subscription limits
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.video_generations (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    identifier text NOT NULL,
    youtube_id text NOT NULL,
    video_id uuid REFERENCES public.video_analyses(id) ON DELETE SET NULL,
    counted_toward_limit boolean DEFAULT true NOT NULL,
    subscription_tier text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

COMMENT ON TABLE public.video_generations IS 'Tracks video generations for subscription limit enforcement';
COMMENT ON COLUMN public.video_generations.counted_toward_limit IS 'Whether this generation counts toward user limits';

-- ----------------------------------------------------------------------------
-- Table: audit_logs
-- Purpose: Security audit trail
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    action text NOT NULL,
    resource_type text,
    resource_id text,
    details jsonb,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

COMMENT ON TABLE public.audit_logs IS 'Security audit trail for tracking important actions';

-- ----------------------------------------------------------------------------
-- Table: topup_purchases
-- Purpose: One-time credit purchase tracking
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.topup_purchases (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_payment_intent_id text UNIQUE NOT NULL,
    credits_purchased integer NOT NULL,
    amount_paid integer NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

COMMENT ON TABLE public.topup_purchases IS 'Tracks one-time credit purchases via Stripe';
COMMENT ON COLUMN public.topup_purchases.amount_paid IS 'Amount in cents';

-- ----------------------------------------------------------------------------
-- Table: stripe_events
-- Purpose: Stripe webhook event deduplication
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stripe_events (
    event_id text PRIMARY KEY,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

COMMENT ON TABLE public.stripe_events IS 'Tracks processed Stripe webhook events to prevent duplicate processing';

-- ============================================================================
-- SECTION 3: INDEXES
-- ============================================================================

-- Profiles indexes
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer_id ON public.profiles(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_profiles_subscription_tier ON public.profiles(subscription_tier);

-- Video analyses indexes
CREATE INDEX IF NOT EXISTS idx_video_analyses_youtube_id ON public.video_analyses(youtube_id);
CREATE INDEX IF NOT EXISTS idx_video_analyses_created_at ON public.video_analyses(created_at);

-- User videos indexes
CREATE INDEX IF NOT EXISTS idx_user_videos_user_id ON public.user_videos(user_id);
CREATE INDEX IF NOT EXISTS idx_user_videos_video_id ON public.user_videos(video_id);
CREATE INDEX IF NOT EXISTS idx_user_videos_is_favorite ON public.user_videos(is_favorite);
CREATE INDEX IF NOT EXISTS idx_user_videos_accessed_at ON public.user_videos(accessed_at);

-- User notes indexes
CREATE INDEX IF NOT EXISTS user_notes_user_video_idx ON public.user_notes(user_id, video_id);
CREATE INDEX IF NOT EXISTS idx_user_notes_user_id ON public.user_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_user_notes_video_id ON public.user_notes(video_id);
CREATE INDEX IF NOT EXISTS idx_user_notes_source ON public.user_notes(source);

-- Rate limits indexes
CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON public.rate_limits(key);
CREATE INDEX IF NOT EXISTS idx_rate_limits_identifier ON public.rate_limits(identifier);
CREATE INDEX IF NOT EXISTS idx_rate_limits_timestamp ON public.rate_limits(timestamp);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key_timestamp ON public.rate_limits(key, timestamp);

-- Video generations indexes
CREATE INDEX IF NOT EXISTS idx_video_generations_user_id ON public.video_generations(user_id);
CREATE INDEX IF NOT EXISTS idx_video_generations_identifier ON public.video_generations(identifier);
CREATE INDEX IF NOT EXISTS idx_video_generations_youtube_id ON public.video_generations(youtube_id);
CREATE INDEX IF NOT EXISTS idx_video_generations_created_at ON public.video_generations(created_at);
CREATE INDEX IF NOT EXISTS idx_video_generations_user_created ON public.video_generations(user_id, created_at);

-- Audit logs indexes
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON public.audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at);

-- Topup purchases indexes
CREATE INDEX IF NOT EXISTS idx_topup_purchases_user_id ON public.topup_purchases(user_id);

-- ============================================================================
-- SECTION 4: FUNCTIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Function: update_updated_at_column
-- Purpose: Generic trigger function to update updated_at timestamp
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- Function: trigger_set_user_notes_updated_at
-- Purpose: Update user_notes.updated_at on modification
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_set_user_notes_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- Function: cleanup_old_rate_limits
-- Purpose: Remove rate limit entries older than 24 hours
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_old_rate_limits()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM public.rate_limits
    WHERE timestamp < (now() - interval '24 hours');
END;
$$;

-- ----------------------------------------------------------------------------
-- Function: handle_new_user
-- Purpose: Create profile for new authenticated users
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, avatar_url)
    VALUES (
        NEW.id,
        NEW.email,
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'avatar_url'
    );
    RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- Function: consume_topup_credit
-- Purpose: Atomically decrement user's topup credits
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_topup_credit(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_credits integer;
BEGIN
    -- Lock the row and get current credits
    SELECT topup_credits INTO v_credits
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;

    -- Check if user has credits
    IF v_credits > 0 THEN
        -- Decrement credits
        UPDATE public.profiles
        SET topup_credits = topup_credits - 1
        WHERE id = p_user_id;
        RETURN true;
    ELSE
        RETURN false;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- Function: increment_topup_credits
-- Purpose: Add credits to user's account after purchase
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_topup_credits(
    p_user_id uuid,
    p_amount integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.profiles
    SET topup_credits = topup_credits + p_amount
    WHERE id = p_user_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- Function: get_usage_breakdown
-- Purpose: Get detailed usage statistics for a user
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_usage_breakdown(
    p_user_id uuid,
    p_start timestamp with time zone DEFAULT NULL,
    p_end timestamp with time zone DEFAULT NULL
)
RETURNS TABLE (
    total_generations bigint,
    smart_generations bigint,
    fast_generations bigint,
    videos_favorited bigint,
    notes_created bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(DISTINCT vg.id) as total_generations,
        COUNT(DISTINCT vg.id) FILTER (WHERE p.topic_generation_mode = 'smart') as smart_generations,
        COUNT(DISTINCT vg.id) FILTER (WHERE p.topic_generation_mode = 'fast') as fast_generations,
        COUNT(DISTINCT uv.id) FILTER (WHERE uv.is_favorite = true) as videos_favorited,
        COUNT(DISTINCT un.id) as notes_created
    FROM public.profiles p
    LEFT JOIN public.video_generations vg ON vg.user_id = p.id
        AND (p_start IS NULL OR vg.created_at >= p_start)
        AND (p_end IS NULL OR vg.created_at <= p_end)
    LEFT JOIN public.user_videos uv ON uv.user_id = p.id
    LEFT JOIN public.user_notes un ON un.user_id = p.id
        AND (p_start IS NULL OR un.created_at >= p_start)
        AND (p_end IS NULL OR un.created_at <= p_end)
    WHERE p.id = p_user_id
    GROUP BY p.id;
END;
$$;

-- ----------------------------------------------------------------------------
-- Function: upsert_video_analysis_with_user_link
-- Purpose: Complex upsert that handles video analysis and user linkage
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_video_analysis_with_user_link(
    p_youtube_id text,
    p_title text,
    p_author text,
    p_duration integer,
    p_thumbnail_url text,
    p_transcript jsonb,
    p_topics jsonb,
    p_summary jsonb,
    p_suggested_questions jsonb,
    p_model_used text,
    p_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_video_id uuid;
BEGIN
    -- Insert or update video analysis
    INSERT INTO public.video_analyses (
        youtube_id,
        title,
        author,
        duration,
        thumbnail_url,
        transcript,
        topics,
        summary,
        suggested_questions,
        model_used
    ) VALUES (
        p_youtube_id,
        p_title,
        p_author,
        p_duration,
        p_thumbnail_url,
        p_transcript,
        p_topics,
        p_summary,
        p_suggested_questions,
        p_model_used
    )
    ON CONFLICT (youtube_id) DO UPDATE SET
        topics = COALESCE(EXCLUDED.topics, video_analyses.topics),
        summary = COALESCE(EXCLUDED.summary, video_analyses.summary),
        suggested_questions = COALESCE(EXCLUDED.suggested_questions, video_analyses.suggested_questions),
        updated_at = timezone('utc'::text, now())
    RETURNING id INTO v_video_id;

    -- Link to user if user_id provided
    IF p_user_id IS NOT NULL THEN
        INSERT INTO public.user_videos (user_id, video_id, accessed_at)
        VALUES (p_user_id, v_video_id, timezone('utc'::text, now()))
        ON CONFLICT (user_id, video_id) DO UPDATE SET
            accessed_at = timezone('utc'::text, now());
    END IF;

    RETURN v_video_id;
END;
$$;

-- ============================================================================
-- SECTION 5: TRIGGERS
-- ============================================================================

-- Trigger: Auto-update updated_at on profiles
DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.profiles;
CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger: Auto-update updated_at on video_analyses
DROP TRIGGER IF EXISTS update_video_analyses_updated_at ON public.video_analyses;
CREATE TRIGGER update_video_analyses_updated_at
    BEFORE UPDATE ON public.video_analyses
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger: Auto-update updated_at on user_notes
DROP TRIGGER IF EXISTS set_user_notes_updated_at ON public.user_notes;
CREATE TRIGGER set_user_notes_updated_at
    BEFORE UPDATE ON public.user_notes
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_set_user_notes_updated_at();

-- Note: The following trigger needs to be created on auth.users table
-- This is typically done via Supabase dashboard or separate auth schema migration:
--
-- CREATE TRIGGER on_auth_user_created
--     AFTER INSERT ON auth.users
--     FOR EACH ROW
--     EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- SECTION 6: ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topup_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- RLS Policies: profiles
-- ----------------------------------------------------------------------------

-- Users can view their own profile
CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT
    USING (auth.uid() = id);

-- Users can update their own profile
CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE
    USING (auth.uid() = id);

-- Service role can manage all profiles
CREATE POLICY "Service role full access to profiles" ON public.profiles
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- ----------------------------------------------------------------------------
-- RLS Policies: video_analyses
-- ----------------------------------------------------------------------------

-- Anyone can view video analyses (public read)
CREATE POLICY "Anyone can view video analyses" ON public.video_analyses
    FOR SELECT
    USING (true);

-- Authenticated users can insert video analyses
CREATE POLICY "Authenticated users can insert video analyses" ON public.video_analyses
    FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

-- Authenticated users can update video analyses
CREATE POLICY "Authenticated users can update video analyses" ON public.video_analyses
    FOR UPDATE
    USING (auth.role() = 'authenticated');

-- Service role can manage all video analyses
CREATE POLICY "Service role full access to video_analyses" ON public.video_analyses
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- ----------------------------------------------------------------------------
-- RLS Policies: user_videos
-- ----------------------------------------------------------------------------

-- Users can view their own video history
CREATE POLICY "Users can view own video history" ON public.user_videos
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own video history
CREATE POLICY "Users can insert own video history" ON public.user_videos
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own video history
CREATE POLICY "Users can update own video history" ON public.user_videos
    FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can delete their own video history
CREATE POLICY "Users can delete own video history" ON public.user_videos
    FOR DELETE
    USING (auth.uid() = user_id);

-- Service role can manage all user videos
CREATE POLICY "Service role full access to user_videos" ON public.user_videos
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- ----------------------------------------------------------------------------
-- RLS Policies: user_notes
-- ----------------------------------------------------------------------------

-- Users can view their own notes
CREATE POLICY "Users can view own notes" ON public.user_notes
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own notes
CREATE POLICY "Users can insert own notes" ON public.user_notes
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own notes
CREATE POLICY "Users can update own notes" ON public.user_notes
    FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can delete their own notes
CREATE POLICY "Users can delete own notes" ON public.user_notes
    FOR DELETE
    USING (auth.uid() = user_id);

-- Service role can manage all notes
CREATE POLICY "Service role full access to user_notes" ON public.user_notes
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- ----------------------------------------------------------------------------
-- RLS Policies: rate_limits
-- ----------------------------------------------------------------------------

-- Anyone can read rate limits (needed for rate limit checks)
CREATE POLICY "Anyone can read rate limits" ON public.rate_limits
    FOR SELECT
    USING (true);

-- Anyone can insert rate limits (needed for rate limiting)
CREATE POLICY "Anyone can insert rate limits" ON public.rate_limits
    FOR INSERT
    WITH CHECK (true);

-- Service role can delete old rate limits (cleanup)
CREATE POLICY "Service role can delete rate limits" ON public.rate_limits
    FOR DELETE
    USING (auth.jwt()->>'role' = 'service_role');

-- ----------------------------------------------------------------------------
-- RLS Policies: video_generations
-- ----------------------------------------------------------------------------

-- Service role only (used for subscription tracking)
CREATE POLICY "Service role full access to video_generations" ON public.video_generations
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- ----------------------------------------------------------------------------
-- RLS Policies: audit_logs
-- ----------------------------------------------------------------------------

-- Service role only (security audit trail)
CREATE POLICY "Service role full access to audit_logs" ON public.audit_logs
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- ----------------------------------------------------------------------------
-- RLS Policies: topup_purchases
-- ----------------------------------------------------------------------------

-- Service role only (payment tracking)
CREATE POLICY "Service role full access to topup_purchases" ON public.topup_purchases
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- ----------------------------------------------------------------------------
-- RLS Policies: stripe_events
-- ----------------------------------------------------------------------------

-- Service role only (webhook deduplication)
CREATE POLICY "Service role full access to stripe_events" ON public.stripe_events
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

-- This migration establishes the complete database schema for the Little universe application.
-- It includes all tables, indexes, functions, triggers, and security policies.
--
-- Note: The auth.users trigger (on_auth_user_created) should be created separately
-- via Supabase dashboard or a dedicated auth schema migration, as it requires
-- modification of the auth schema which is managed by Supabase.
--
-- After applying this migration, verify:
-- 1. All tables are created with correct columns and constraints
-- 2. All indexes are created for optimal query performance
-- 3. All functions are callable and work as expected
-- 4. All triggers fire correctly on INSERT/UPDATE operations
-- 5. RLS policies properly restrict access based on user authentication
-- ============================================================================
