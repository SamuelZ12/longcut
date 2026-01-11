/**
 * Transcription Manager
 *
 * Handles:
 * - Transcription credit checking and consumption
 * - Job lifecycle management
 * - Usage tracking
 */

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getUserSubscriptionStatus, type UserSubscription } from '@/lib/subscription-manager';
import { formatResetAt } from '@/lib/usage-tracker';
import { hasUnlimitedVideoAllowance, hasUnlimitedVideoAllowanceById } from '@/lib/access-control';

type DatabaseClient = SupabaseClient<any, string, any>;

// Transcription limits (minutes per month)
export const TRANSCRIPTION_LIMITS = {
  free: 0,      // No transcription for free users
  pro: 120,     // 120 minutes included with Pro
};

// Topup package: $2.99 for 120 minutes
export const TRANSCRIPTION_TOPUP_MINUTES = 120;

export type TranscriptionJobStatus =
  | 'pending'
  | 'downloading'
  | 'transcribing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TranscriptionJob {
  id: string;
  userId: string;
  videoId: string | null;
  youtubeId: string;
  status: TranscriptionJobStatus;
  errorMessage: string | null;
  durationSeconds: number | null;
  estimatedCostCents: number | null;
  progress: number;
  currentStage: string | null;
  audioStoragePath: string | null;
  transcriptData: any | null;
  totalChunks: number;
  completedChunks: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface TranscriptionUsageStats {
  subscriptionMinutes: {
    used: number;
    limit: number;
    remaining: number;
  };
  topupMinutes: number;
  totalRemaining: number;
  periodStart: Date;
  periodEnd: Date;
  resetAt: string;
}

export interface TranscriptionDecision {
  allowed: boolean;
  reason:
    | 'OK'
    | 'NOT_PRO'
    | 'INSUFFICIENT_CREDITS'
    | 'NO_SUBSCRIPTION'
    | 'EXISTING_JOB';
  stats?: TranscriptionUsageStats | null;
  subscription?: UserSubscription | null;
  willUseTopup?: boolean;
  minutesNeeded?: number;
  existingJobId?: string;
  unlimited?: boolean;
}

/**
 * Resolve billing period for a user (same logic as subscription-manager)
 */
function resolveBillingPeriod(
  subscription: UserSubscription,
  now: Date
): { start: Date; end: Date } {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // Pro users: use Stripe billing period
  if (
    subscription.tier === 'pro' &&
    subscription.currentPeriodStart &&
    subscription.currentPeriodEnd
  ) {
    return {
      start: subscription.currentPeriodStart,
      end: subscription.currentPeriodEnd,
    };
  }

  // Free users: calculate fixed 30-day billing cycles from signup date
  if (subscription.userCreatedAt) {
    const signupTime = subscription.userCreatedAt.getTime();
    const currentTime = now.getTime();
    const elapsedMs = currentTime - signupTime;
    const cycleNumber = Math.floor(elapsedMs / THIRTY_DAYS_MS);
    const periodStartMs = signupTime + cycleNumber * THIRTY_DAYS_MS;
    const periodEndMs = periodStartMs + THIRTY_DAYS_MS;

    return {
      start: new Date(periodStartMs),
      end: new Date(periodEndMs),
    };
  }

  // Fallback: rolling window
  const end = now;
  const start = new Date(end.getTime() - THIRTY_DAYS_MS);
  return { start, end };
}

/**
 * Get transcription usage statistics for a user
 */
export async function getTranscriptionUsageStats(
  userId: string,
  options?: { client?: DatabaseClient; now?: Date }
): Promise<TranscriptionUsageStats | null> {
  const supabase = options?.client ?? (await createClient());
  const now = options?.now ?? new Date();

  // Get user subscription
  const subscription = await getUserSubscriptionStatus(userId, { client: supabase });

  if (!subscription) {
    return null;
  }

  // Only Pro users can use transcription
  if (subscription.tier !== 'pro') {
    const { start, end } = resolveBillingPeriod(subscription, now);
    return {
      subscriptionMinutes: {
        used: 0,
        limit: 0,
        remaining: 0,
      },
      topupMinutes: 0,
      totalRemaining: 0,
      periodStart: start,
      periodEnd: end,
      resetAt: formatResetAt(end),
    };
  }

  const { start, end } = resolveBillingPeriod(subscription, now);

  // Get subscription usage in current period
  const { data: usedMinutesData, error: usageError } = await supabase.rpc(
    'get_transcription_usage_in_period',
    {
      p_user_id: userId,
      p_period_start: start.toISOString(),
      p_period_end: end.toISOString(),
    }
  );

  if (usageError) {
    console.error('Error fetching transcription usage:', usageError);
  }

  const usedMinutes = (usedMinutesData as number) || 0;
  const limit = TRANSCRIPTION_LIMITS.pro;
  const subscriptionRemaining = Math.max(0, limit - usedMinutes);

  // Get topup balance
  const { data: profile } = await supabase
    .from('profiles')
    .select('transcription_minutes_topup')
    .eq('id', userId)
    .maybeSingle();

  const topupMinutes = profile?.transcription_minutes_topup ?? 0;

  return {
    subscriptionMinutes: {
      used: usedMinutes,
      limit,
      remaining: subscriptionRemaining,
    },
    topupMinutes,
    totalRemaining: subscriptionRemaining + topupMinutes,
    periodStart: start,
    periodEnd: end,
    resetAt: formatResetAt(end),
  };
}

/**
 * Check if a user can start a transcription job
 */
export async function canStartTranscription(
  userId: string,
  youtubeId: string,
  estimatedMinutes: number,
  options?: { client?: DatabaseClient; now?: Date; user?: User }
): Promise<TranscriptionDecision> {
  const supabase = options?.client ?? (await createClient());
  const now = options?.now ?? new Date();

  // Check for unlimited access first (bypasses all other checks)
  if (
    (options?.user && hasUnlimitedVideoAllowance(options.user)) ||
    hasUnlimitedVideoAllowanceById(userId)
  ) {
    return {
      allowed: true,
      reason: 'OK',
      unlimited: true,
      minutesNeeded: estimatedMinutes,
    };
  }

  const subscription = await getUserSubscriptionStatus(userId, { client: supabase });

  if (!subscription) {
    return {
      allowed: false,
      reason: 'NO_SUBSCRIPTION',
    };
  }

  // Only Pro users can use transcription
  if (subscription.tier !== 'pro') {
    return {
      allowed: false,
      reason: 'NOT_PRO',
      subscription,
    };
  }

  // Check for existing pending/in-progress job for this video
  const { data: existingJob } = await supabase
    .from('transcription_jobs')
    .select('id, status')
    .eq('user_id', userId)
    .eq('youtube_id', youtubeId)
    .in('status', ['pending', 'downloading', 'transcribing'])
    .maybeSingle();

  if (existingJob) {
    return {
      allowed: false,
      reason: 'EXISTING_JOB',
      existingJobId: existingJob.id,
      subscription,
    };
  }

  const stats = await getTranscriptionUsageStats(userId, { client: supabase, now });

  if (!stats) {
    return {
      allowed: false,
      reason: 'NO_SUBSCRIPTION',
      subscription,
    };
  }

  // Check if enough credits available
  if (stats.totalRemaining < estimatedMinutes) {
    return {
      allowed: false,
      reason: 'INSUFFICIENT_CREDITS',
      stats,
      subscription,
      minutesNeeded: estimatedMinutes,
    };
  }

  const willUseTopup =
    stats.subscriptionMinutes.remaining < estimatedMinutes &&
    stats.topupMinutes > 0;

  return {
    allowed: true,
    reason: 'OK',
    stats,
    subscription,
    willUseTopup,
    minutesNeeded: estimatedMinutes,
  };
}

/**
 * Create a new transcription job
 */
export async function createTranscriptionJob(
  userId: string,
  youtubeId: string,
  options?: {
    client?: DatabaseClient;
    videoId?: string;
    durationSeconds?: number;
    estimatedCostCents?: number;
  }
): Promise<{ success: boolean; jobId?: string; error?: string }> {
  const supabase = options?.client ?? (await createClient());

  const { data, error } = await supabase
    .from('transcription_jobs')
    .insert({
      user_id: userId,
      youtube_id: youtubeId,
      video_id: options?.videoId ?? null,
      duration_seconds: options?.durationSeconds ?? null,
      estimated_cost_cents: options?.estimatedCostCents ?? null,
      status: 'pending',
      progress: 0,
    })
    .select('id')
    .single();

  if (error) {
    console.error('Error creating transcription job:', error);
    return { success: false, error: 'FAILED_TO_CREATE_JOB' };
  }

  return { success: true, jobId: data.id };
}

/**
 * Update transcription job status
 */
export async function updateTranscriptionJobStatus(
  jobId: string,
  updates: {
    status?: TranscriptionJobStatus;
    progress?: number;
    currentStage?: string;
    errorMessage?: string;
    transcriptData?: any;
    completedChunks?: number;
    startedAt?: Date;
    completedAt?: Date;
  },
  options?: { client?: DatabaseClient }
): Promise<{ success: boolean; error?: string }> {
  const supabase = options?.client ?? (await createClient());

  const updatePayload: Record<string, unknown> = {};

  if (updates.status !== undefined) updatePayload.status = updates.status;
  if (updates.progress !== undefined) updatePayload.progress = updates.progress;
  if (updates.currentStage !== undefined) updatePayload.current_stage = updates.currentStage;
  if (updates.errorMessage !== undefined) updatePayload.error_message = updates.errorMessage;
  if (updates.transcriptData !== undefined) updatePayload.transcript_data = updates.transcriptData;
  if (updates.completedChunks !== undefined) updatePayload.completed_chunks = updates.completedChunks;
  if (updates.startedAt !== undefined) updatePayload.started_at = updates.startedAt.toISOString();
  if (updates.completedAt !== undefined) updatePayload.completed_at = updates.completedAt.toISOString();

  const { error } = await supabase
    .from('transcription_jobs')
    .update(updatePayload)
    .eq('id', jobId);

  if (error) {
    console.error('Error updating transcription job:', error);
    return { success: false, error: 'FAILED_TO_UPDATE_JOB' };
  }

  return { success: true };
}

/**
 * Get a transcription job by ID
 */
export async function getTranscriptionJob(
  jobId: string,
  options?: { client?: DatabaseClient }
): Promise<TranscriptionJob | null> {
  const supabase = options?.client ?? (await createClient());

  const { data, error } = await supabase
    .from('transcription_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return mapDbJobToTranscriptionJob(data);
}

/**
 * Get active transcription job for a video
 */
export async function getActiveTranscriptionJob(
  userId: string,
  youtubeId: string,
  options?: { client?: DatabaseClient }
): Promise<TranscriptionJob | null> {
  const supabase = options?.client ?? (await createClient());

  const { data, error } = await supabase
    .from('transcription_jobs')
    .select('*')
    .eq('user_id', userId)
    .eq('youtube_id', youtubeId)
    .in('status', ['pending', 'downloading', 'transcribing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return mapDbJobToTranscriptionJob(data);
}

/**
 * Get completed transcription for a video
 */
export async function getCompletedTranscription(
  youtubeId: string,
  options?: { client?: DatabaseClient }
): Promise<TranscriptionJob | null> {
  const supabase = options?.client ?? (await createClient());

  const { data, error } = await supabase
    .from('transcription_jobs')
    .select('*')
    .eq('youtube_id', youtubeId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return mapDbJobToTranscriptionJob(data);
}

/**
 * Consume transcription minutes atomically
 */
export async function consumeTranscriptionMinutes(
  userId: string,
  jobId: string,
  minutes: number,
  options?: { client?: DatabaseClient; now?: Date; user?: User }
): Promise<{
  success: boolean;
  error?: string;
  minutesFromSubscription?: number;
  minutesFromTopup?: number;
  unlimited?: boolean;
}> {
  const supabase = options?.client ?? (await createClient());
  const now = options?.now ?? new Date();

  // Skip consumption for unlimited users (check both user object and userId)
  if (
    (options?.user && hasUnlimitedVideoAllowance(options.user)) ||
    hasUnlimitedVideoAllowanceById(userId)
  ) {
    return { success: true, unlimited: true };
  }

  const subscription = await getUserSubscriptionStatus(userId, { client: supabase });

  if (!subscription || subscription.tier !== 'pro') {
    return { success: false, error: 'NOT_PRO' };
  }

  const { start, end } = resolveBillingPeriod(subscription, now);

  const { data, error } = await supabase.rpc('consume_transcription_minutes_atomically', {
    p_user_id: userId,
    p_job_id: jobId,
    p_minutes: minutes,
    p_subscription_limit: TRANSCRIPTION_LIMITS.pro,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
  });

  if (error) {
    console.error('Error consuming transcription minutes:', error);
    return { success: false, error: 'CONSUMPTION_FAILED' };
  }

  const result = data as any;

  if (!result || !result.allowed) {
    return {
      success: false,
      error: result?.reason || 'INSUFFICIENT_CREDITS',
    };
  }

  return {
    success: true,
    minutesFromSubscription: result.minutes_from_subscription || 0,
    minutesFromTopup: result.minutes_from_topup || 0,
  };
}

/**
 * Refund transcription minutes for a failed/cancelled job
 */
export async function refundTranscriptionMinutes(
  jobId: string,
  options?: { client?: DatabaseClient }
): Promise<{ success: boolean; minutesRefunded?: number; error?: string }> {
  const supabase = options?.client ?? (await createClient());

  const { data, error } = await supabase.rpc('refund_transcription_minutes', {
    p_job_id: jobId,
  });

  if (error) {
    console.error('Error refunding transcription minutes:', error);
    return { success: false, error: 'REFUND_FAILED' };
  }

  const result = data as any;

  return {
    success: result?.success ?? false,
    minutesRefunded: result?.minutes_refunded ?? 0,
  };
}

/**
 * Cancel a transcription job
 */
export async function cancelTranscriptionJob(
  jobId: string,
  options?: { client?: DatabaseClient }
): Promise<{ success: boolean; error?: string }> {
  const supabase = options?.client ?? (await createClient());

  // First, update the job status
  const { error: updateError } = await supabase
    .from('transcription_jobs')
    .update({
      status: 'cancelled',
      error_message: 'Cancelled by user',
    })
    .eq('id', jobId)
    .in('status', ['pending', 'downloading', 'transcribing']);

  if (updateError) {
    console.error('Error cancelling transcription job:', updateError);
    return { success: false, error: 'FAILED_TO_CANCEL' };
  }

  // Refund any consumed minutes
  await refundTranscriptionMinutes(jobId, { client: supabase });

  return { success: true };
}

/**
 * Add transcription topup credits
 */
export async function addTranscriptionTopupCredits(
  userId: string,
  stripePaymentIntentId: string,
  minutes: number,
  amountPaid: number,
  options?: { client?: DatabaseClient }
): Promise<{
  success: boolean;
  alreadyProcessed?: boolean;
  newBalance?: number;
  error?: string;
}> {
  const supabase = options?.client ?? (await createClient());

  const { data, error } = await supabase.rpc('add_transcription_topup_credits', {
    p_user_id: userId,
    p_stripe_payment_intent_id: stripePaymentIntentId,
    p_minutes: minutes,
    p_amount_paid: amountPaid,
  });

  if (error) {
    console.error('Error adding transcription topup credits:', error);
    return { success: false, error: 'FAILED_TO_ADD_CREDITS' };
  }

  const result = data as any;

  return {
    success: result?.success ?? false,
    alreadyProcessed: result?.already_processed ?? false,
    newBalance: result?.new_balance ?? undefined,
  };
}

/**
 * Map database row to TranscriptionJob type
 */
function mapDbJobToTranscriptionJob(row: any): TranscriptionJob {
  return {
    id: row.id,
    userId: row.user_id,
    videoId: row.video_id,
    youtubeId: row.youtube_id,
    status: row.status,
    errorMessage: row.error_message,
    durationSeconds: row.duration_seconds,
    estimatedCostCents: row.estimated_cost_cents,
    progress: row.progress ?? 0,
    currentStage: row.current_stage,
    audioStoragePath: row.audio_storage_path,
    transcriptData: row.transcript_data,
    totalChunks: row.total_chunks ?? 1,
    completedChunks: row.completed_chunks ?? 0,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    updatedAt: new Date(row.updated_at),
  };
}

export const TranscriptionManager = {
  getTranscriptionUsageStats,
  canStartTranscription,
  createTranscriptionJob,
  updateTranscriptionJobStatus,
  getTranscriptionJob,
  getActiveTranscriptionJob,
  getCompletedTranscription,
  consumeTranscriptionMinutes,
  refundTranscriptionMinutes,
  cancelTranscriptionJob,
  addTranscriptionTopupCredits,
  TRANSCRIPTION_LIMITS,
  TRANSCRIPTION_TOPUP_MINUTES,
};

export default TranscriptionManager;
