-- ============================================================================
-- Welcome Email System Migration
-- ============================================================================
-- This migration creates the infrastructure for sending welcome emails
-- 5 minutes after user signup using pg_cron and pg_net.
-- ============================================================================

-- ============================================================================
-- SECTION 1: TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pending_welcome_emails (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email text NOT NULL,
    full_name text,
    send_at timestamp with time zone NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 3,
    last_attempt_at timestamp with time zone,
    last_error text,
    http_request_id bigint,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,

    CONSTRAINT pending_welcome_emails_status_check
        CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
    CONSTRAINT pending_welcome_emails_user_unique UNIQUE (user_id)
);

COMMENT ON TABLE public.pending_welcome_emails IS 'Queue for delayed welcome emails sent 5 minutes after signup';
COMMENT ON COLUMN public.pending_welcome_emails.send_at IS 'When the email should be sent (signup time + 5 minutes)';
COMMENT ON COLUMN public.pending_welcome_emails.status IS 'pending=waiting, processing=API call in progress, sent=delivered, failed=max retries exceeded, cancelled=user deleted';
COMMENT ON COLUMN public.pending_welcome_emails.http_request_id IS 'pg_net request ID for tracking response';

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_pending_welcome_emails_status_send_at
    ON public.pending_welcome_emails(status, send_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_welcome_emails_processing
    ON public.pending_welcome_emails(status, http_request_id)
    WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_pending_welcome_emails_user_id
    ON public.pending_welcome_emails(user_id);

-- ============================================================================
-- SECTION 2: TRIGGER TO QUEUE WELCOME EMAILS ON PROFILE CREATION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.queue_welcome_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
    -- Only queue if email exists (should always be true, but safety check)
    IF NEW.email IS NOT NULL THEN
        INSERT INTO public.pending_welcome_emails (
            user_id,
            email,
            full_name,
            send_at
        ) VALUES (
            NEW.id,
            NEW.email,
            NEW.full_name,
            timezone('utc'::text, now()) + interval '5 minutes'
        )
        ON CONFLICT (user_id) DO NOTHING; -- Prevent duplicates if profile is recreated
    END IF;

    RETURN NEW;
END;
$$;

-- Trigger on profiles table (fires after handle_new_user creates the profile)
DROP TRIGGER IF EXISTS on_profile_created_queue_welcome_email ON public.profiles;
CREATE TRIGGER on_profile_created_queue_welcome_email
    AFTER INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.queue_welcome_email();

-- ============================================================================
-- SECTION 3: FUNCTION TO PROCESS WELCOME EMAILS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.process_welcome_emails()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
    email_record RECORD;
    api_url text;
    api_key text;
    request_id bigint;
BEGIN
    -- Get API configuration from vault
    SELECT decrypted_secret INTO api_url
    FROM vault.decrypted_secrets
    WHERE name = 'app_url';

    SELECT decrypted_secret INTO api_key
    FROM vault.decrypted_secrets
    WHERE name = 'internal_api_key';

    IF api_url IS NULL OR api_key IS NULL THEN
        RAISE WARNING 'Welcome email config missing: app_url or internal_api_key not found in vault';
        RETURN;
    END IF;

    -- Process emails that are ready to send
    FOR email_record IN
        SELECT id, user_id, email, full_name
        FROM public.pending_welcome_emails
        WHERE status = 'pending'
          AND send_at <= timezone('utc'::text, now())
          AND attempts < max_attempts
        ORDER BY send_at ASC
        LIMIT 10  -- Process up to 10 emails per run to avoid overload
        FOR UPDATE SKIP LOCKED  -- Skip rows being processed by another job
    LOOP
        -- Mark as processing and increment attempts
        UPDATE public.pending_welcome_emails
        SET
            status = 'processing',
            attempts = attempts + 1,
            last_attempt_at = timezone('utc'::text, now()),
            updated_at = timezone('utc'::text, now())
        WHERE id = email_record.id;

        -- Make async HTTP request to send email
        SELECT net.http_post(
            url := api_url || '/api/email/send-welcome',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'X-Internal-API-Key', api_key
            ),
            body := jsonb_build_object(
                'emailId', email_record.id,
                'userId', email_record.user_id,
                'email', email_record.email,
                'fullName', email_record.full_name
            ),
            timeout_milliseconds := 30000  -- 30 second timeout
        ) INTO request_id;

        -- Store the request ID for response tracking
        UPDATE public.pending_welcome_emails
        SET
            http_request_id = request_id,
            updated_at = timezone('utc'::text, now())
        WHERE id = email_record.id;

    END LOOP;
END;
$$;

-- ============================================================================
-- SECTION 4: FUNCTION TO HANDLE HTTP RESPONSES
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_welcome_email_responses()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
    response_record RECORD;
    email_record RECORD;
    response_body jsonb;
BEGIN
    -- Check responses for processing emails
    FOR email_record IN
        SELECT pwe.id, pwe.http_request_id, pwe.attempts, pwe.max_attempts
        FROM public.pending_welcome_emails pwe
        WHERE pwe.status = 'processing'
          AND pwe.http_request_id IS NOT NULL
    LOOP
        -- Look up the response
        SELECT * INTO response_record
        FROM net._http_response
        WHERE id = email_record.http_request_id;

        IF response_record IS NULL THEN
            -- Response not yet received, check for timeout (> 2 minutes processing)
            IF EXISTS (
                SELECT 1 FROM public.pending_welcome_emails
                WHERE id = email_record.id
                  AND last_attempt_at < timezone('utc'::text, now()) - interval '2 minutes'
            ) THEN
                -- Timeout - reset to pending for retry or mark as failed
                IF email_record.attempts >= email_record.max_attempts THEN
                    UPDATE public.pending_welcome_emails
                    SET
                        status = 'failed',
                        last_error = 'Request timeout after 2 minutes',
                        updated_at = timezone('utc'::text, now())
                    WHERE id = email_record.id;
                ELSE
                    UPDATE public.pending_welcome_emails
                    SET
                        status = 'pending',
                        last_error = 'Request timeout - will retry',
                        http_request_id = NULL,
                        updated_at = timezone('utc'::text, now())
                    WHERE id = email_record.id;
                END IF;
            END IF;
            CONTINUE;
        END IF;

        -- Process the response
        IF response_record.status_code = 200 THEN
            -- Success - mark as sent
            UPDATE public.pending_welcome_emails
            SET
                status = 'sent',
                updated_at = timezone('utc'::text, now())
            WHERE id = email_record.id;
        ELSE
            -- Failure - check if we should retry
            BEGIN
                response_body := response_record.content::jsonb;
            EXCEPTION WHEN OTHERS THEN
                response_body := jsonb_build_object('error', response_record.content);
            END;

            IF email_record.attempts >= email_record.max_attempts THEN
                -- Max retries exceeded
                UPDATE public.pending_welcome_emails
                SET
                    status = 'failed',
                    last_error = COALESCE(
                        response_body->>'error',
                        'HTTP ' || response_record.status_code::text
                    ),
                    updated_at = timezone('utc'::text, now())
                WHERE id = email_record.id;
            ELSE
                -- Reset to pending for retry (with exponential backoff via send_at)
                UPDATE public.pending_welcome_emails
                SET
                    status = 'pending',
                    send_at = timezone('utc'::text, now()) + (interval '1 minute' * attempts),
                    last_error = COALESCE(
                        response_body->>'error',
                        'HTTP ' || response_record.status_code::text
                    ),
                    http_request_id = NULL,
                    updated_at = timezone('utc'::text, now())
                WHERE id = email_record.id;
            END IF;
        END IF;

        -- Clean up the response (pg_net stores responses for 6 hours by default)
        -- We can delete immediately after processing
        DELETE FROM net._http_response WHERE id = email_record.http_request_id;

    END LOOP;
END;
$$;

-- ============================================================================
-- SECTION 5: CRON JOBS
-- ============================================================================

-- Schedule email processing every minute
SELECT cron.schedule(
    'process-welcome-emails',
    '* * * * *',  -- Every minute
    $$SELECT public.process_welcome_emails();$$
);

-- Schedule response handling every minute
SELECT cron.schedule(
    'handle-welcome-email-responses',
    '* * * * *',  -- Every minute
    $$SELECT public.handle_welcome_email_responses();$$
);

-- ============================================================================
-- SECTION 6: ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.pending_welcome_emails ENABLE ROW LEVEL SECURITY;

-- Service role only - users should not access this table
CREATE POLICY "Service role full access to pending_welcome_emails"
    ON public.pending_welcome_emails
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- ============================================================================
-- SECTION 7: CLEANUP FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_old_welcome_emails()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Delete sent emails older than 30 days
    DELETE FROM public.pending_welcome_emails
    WHERE status = 'sent'
      AND updated_at < timezone('utc'::text, now()) - interval '30 days';

    -- Delete failed emails older than 90 days
    DELETE FROM public.pending_welcome_emails
    WHERE status = 'failed'
      AND updated_at < timezone('utc'::text, now()) - interval '90 days';
END;
$$;

-- Schedule cleanup weekly (Sunday at 3 AM UTC)
SELECT cron.schedule(
    'cleanup-welcome-emails',
    '0 3 * * 0',  -- Every Sunday at 3 AM UTC
    $$SELECT public.cleanup_old_welcome_emails();$$
);

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- After applying this migration, you must also:
-- 1. Add secrets to Supabase Vault (run in SQL editor):
--    SELECT vault.create_secret('https://longcut.ai', 'app_url');
--    SELECT vault.create_secret('your-secure-api-key', 'internal_api_key');
-- 2. Add INTERNAL_API_KEY environment variable to your app (same value as above)
-- ============================================================================
