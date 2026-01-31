import type { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeClient } from '@/lib/stripe-client';
import { createClient } from '@/lib/supabase/server';
import {
  fetchUsageBreakdown,
  formatResetAt,
  getRemainingCredits as computeRemainingCredits,
  type UsageBreakdown,
} from '@/lib/usage-tracker';
import type { ProfilesUpdate, SubscriptionStatus, SubscriptionTier } from '@/lib/supabase/types';

export type { SubscriptionStatus, SubscriptionTier };

type DatabaseClient = SupabaseClient<any, string, any>;

export interface UserSubscription {
  userId: string;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  topupCredits: number;
  userCreatedAt: Date | null;
}

export interface UsageStats {
  tier: SubscriptionTier;
  baseLimit: number;
  counted: number;
  cached: number;
  baseRemaining: number;
  topupCredits: number;
  topupRemaining: number;
  totalRemaining: number;
  periodStart: Date;
  periodEnd: Date;
  resetAt: string;
}

export interface GenerationDecision {
  allowed: boolean;
  reason: 'OK' | 'CACHED' | 'LIMIT_REACHED' | 'SUBSCRIPTION_INACTIVE' | 'NO_SUBSCRIPTION';
  subscription?: UserSubscription | null;
  stats?: UsageStats | null;
  warning?: 'PAST_DUE';
  willConsumeTopup?: boolean;
  requiresTopupPurchase?: boolean;
}

export const TIER_LIMITS: Record<SubscriptionTier, number> = {
  free: 3,
  pro: 100,
};

const BILLING_PERIOD_DAYS = 30;
const THIRTY_DAYS_MS = BILLING_PERIOD_DAYS * 24 * 60 * 60 * 1000;

function resolveBillingPeriod(subscription: UserSubscription, now: Date): { start: Date; end: Date } {
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

    // Calculate which billing cycle we're in (0-indexed)
    const cycleNumber = Math.floor(elapsedMs / THIRTY_DAYS_MS);

    // Calculate period start and end for the current cycle
    const periodStartMs = signupTime + (cycleNumber * THIRTY_DAYS_MS);
    const periodEndMs = periodStartMs + THIRTY_DAYS_MS;

    return {
      start: new Date(periodStartMs),
      end: new Date(periodEndMs),
    };
  }

  // Fallback for users without creation date: rolling window
  const end = now;
  const start = new Date(end.getTime() - THIRTY_DAYS_MS);
  return { start, end };
}

export async function getUserSubscriptionStatus(
  userId: string,
  options?: { client?: DatabaseClient }
): Promise<UserSubscription | null> {
  const supabase = options?.client ?? (await createClient());

  const { data: profile, error } = await supabase
    .from('profiles')
    .select(
      'id, subscription_tier, subscription_status, stripe_customer_id, stripe_subscription_id, subscription_current_period_start, subscription_current_period_end, cancel_at_period_end, topup_credits, created_at'
    )
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('Error fetching subscription from profiles:', error);
    // Return default free-tier subscription instead of null
    return {
      userId,
      tier: 'free',
      status: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      topupCredits: 0,
      userCreatedAt: null,
    };
  }

  if (!profile) {
    // Return default free-tier subscription for users without profiles
    return {
      userId,
      tier: 'free',
      status: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      topupCredits: 0,
      userCreatedAt: null,
    };
  }

  return {
    userId: profile.id,
    tier: profile.subscription_tier ?? 'free',
    status: profile.subscription_status,
    stripeCustomerId: profile.stripe_customer_id,
    stripeSubscriptionId: profile.stripe_subscription_id,
    currentPeriodStart: profile.subscription_current_period_start
      ? new Date(profile.subscription_current_period_start)
      : null,
    currentPeriodEnd: profile.subscription_current_period_end
      ? new Date(profile.subscription_current_period_end)
      : null,
    cancelAtPeriodEnd: Boolean(profile.cancel_at_period_end),
    topupCredits: Number(profile.topup_credits ?? 0),
    userCreatedAt: profile.created_at ? new Date(profile.created_at) : null,
  };
}

export async function calculateUsageInPeriod(
  userId: string,
  periodStart: Date,
  periodEnd: Date,
  options?: { client?: DatabaseClient }
): Promise<UsageBreakdown> {
  return fetchUsageBreakdown({
    userId,
    start: periodStart,
    end: periodEnd,
    client: options?.client,
  });
}

export async function getUsageStats(
  userId: string,
  options?: { client?: DatabaseClient; now?: Date }
): Promise<UsageStats | null> {
  const supabase = options?.client ?? (await createClient());
  const subscription = await getUserSubscriptionStatus(userId, { client: supabase });

  if (!subscription) {
    return null;
  }

  const now = options?.now ?? new Date();
  const { start, end } = resolveBillingPeriod(subscription, now);

  let usage: UsageBreakdown;

  try {
    usage = await calculateUsageInPeriod(userId, start, end, { client: supabase });
  } catch (error) {
    console.error('Failed to calculate usage in period:', error);
    usage = {
      counted: 0,
      cached: 0,
      total: 0,
      byTier: {},
    };
  }

  const baseLimit = TIER_LIMITS[subscription.tier];
  const remaining = computeRemainingCredits({
    baseLimit,
    countedUsage: usage.counted,
    topupCredits: subscription.topupCredits,
  });

  return {
    tier: subscription.tier,
    baseLimit,
    counted: usage.counted,
    cached: usage.cached,
    baseRemaining: remaining.baseRemaining,
    topupCredits: subscription.topupCredits,
    topupRemaining: remaining.topupRemaining,
    totalRemaining: remaining.totalRemaining,
    periodStart: start,
    periodEnd: end,
    resetAt: formatResetAt(end),
  };
}

export async function canGenerateVideo(
  userId: string,
  youtubeId?: string,
  options?: {
    client?: DatabaseClient;
    now?: Date;
    skipCacheCheck?: boolean;
  }
): Promise<GenerationDecision> {
  const supabase = options?.client ?? (await createClient());
  const now = options?.now ?? new Date();

  const subscription = await getUserSubscriptionStatus(userId, { client: supabase });

  if (!subscription) {
    return {
      allowed: false,
      reason: 'NO_SUBSCRIPTION',
    };
  }

  const stats = await getUsageStats(userId, { client: supabase, now });

  if (!stats) {
    return {
      allowed: false,
      reason: 'NO_SUBSCRIPTION',
      subscription,
    };
  }

  const warning = subscription.status === 'past_due' ? 'PAST_DUE' : undefined;

  if (!options?.skipCacheCheck && youtubeId) {
    const cached = await isVideoCached(youtubeId, supabase);
    if (cached) {
      return {
        allowed: true,
        reason: 'CACHED',
        subscription,
        stats,
        warning,
        willConsumeTopup: false,
      };
    }
  }

  if (
    subscription.tier === 'pro' &&
    subscription.status &&
    !['active', 'trialing', 'past_due'].includes(subscription.status)
  ) {
    return {
      allowed: false,
      reason: 'SUBSCRIPTION_INACTIVE',
      subscription,
      stats,
      warning,
    };
  }

  if (stats.totalRemaining <= 0) {
    const requiresTopupPurchase = subscription.tier === 'pro';
    return {
      allowed: false,
      reason: 'LIMIT_REACHED',
      subscription,
      stats,
      warning,
      requiresTopupPurchase,
    };
  }

  const willConsumeTopup =
    stats.baseRemaining <= 0 && stats.topupRemaining > 0;

  return {
    allowed: true,
    reason: 'OK',
    subscription,
    stats,
    warning,
    willConsumeTopup,
    requiresTopupPurchase: false,
  };
}

interface ConsumeVideoCreditOptions {
  userId: string;
  youtubeId: string;
  subscription: UserSubscription;
  statsSnapshot: UsageStats;
  videoAnalysisId?: string | null;
  counted?: boolean;
  identifier?: string;
  client?: DatabaseClient;
}

/**
 * DEPRECATED: Use consumeVideoCreditAtomic instead to prevent race conditions
 * This function has a race condition between check and consume operations
 *
 * @deprecated
 */
export async function consumeVideoCredit({
  userId,
  youtubeId,
  subscription,
  statsSnapshot,
  videoAnalysisId,
  counted = true,
  identifier,
  client,
}: ConsumeVideoCreditOptions): Promise<{
  success: boolean;
  generationId?: string;
  error?: string;
  usedTopup?: boolean;
}> {
  const supabase = client ?? (await createClient());

  const payload = {
    user_id: userId,
    identifier: identifier ?? `user:${userId}`,
    youtube_id: youtubeId,
    video_id: videoAnalysisId ?? null,
    counted_toward_limit: counted,
    subscription_tier: subscription.tier,
  };

  const { data, error } = await supabase
    .from('video_generations')
    .insert(payload)
    .select('id')
    .maybeSingle();

  if (error || !data) {
    console.error('Error recording video generation:', error);
    return { success: false, error: 'FAILED_TO_RECORD_GENERATION' };
  }

  let usedTopup = false;

  if (counted) {
    const shouldConsumeTopup =
      statsSnapshot.baseRemaining <= 0 &&
      statsSnapshot.topupRemaining > 0 &&
      subscription.tier === 'pro';

    if (shouldConsumeTopup) {
      const { data: rpcData, error: rpcError } = await supabase.rpc('consume_topup_credit', {
        p_user_id: userId,
      });

      if (rpcError) {
        console.error('Failed to decrement top-up credit:', rpcError);
      } else {
        usedTopup = Boolean(rpcData);
      }
    }
  }

  return { success: true, generationId: data.id, usedTopup };
}

/**
 * Atomically consumes a video credit with proper transaction handling
 * This prevents race conditions by locking the profile row during check-and-consume
 *
 * @param options - Credit consumption options
 * @returns Result with success status and generation details
 */
export async function consumeVideoCreditAtomic({
  userId,
  youtubeId,
  subscription,
  statsSnapshot,
  videoAnalysisId,
  counted = true,
  identifier,
  client,
}: ConsumeVideoCreditOptions): Promise<{
  success: boolean;
  generationId?: string;
  error?: string;
  usedTopup?: boolean;
  allowed?: boolean;
  reason?: string;
  deduplicated?: boolean;
}> {
  const supabase = client ?? (await createClient());

  // Call atomic RPC function that handles check + consume in single transaction
  const { data, error } = await supabase.rpc('consume_video_credit_atomically', {
    p_user_id: userId,
    p_youtube_id: youtubeId,
    p_identifier: identifier ?? `user:${userId}`,
    p_subscription_tier: subscription.tier,
    p_base_limit: TIER_LIMITS[subscription.tier],
    p_period_start: statsSnapshot.periodStart.toISOString(),
    p_period_end: statsSnapshot.periodEnd.toISOString(),
    p_video_id: videoAnalysisId ?? null,
    p_counted: counted,
  });

  if (error) {
    console.error('Atomic credit consumption failed:', error);
    return { success: false, error: 'ATOMIC_CONSUMPTION_FAILED' };
  }

  // RPC returns jsonb with: { allowed, reason, generation_id, used_topup, ... }
  const result = data as any;

  if (!result || !result.allowed) {
    return {
      success: false,
      allowed: false,
      reason: result?.reason || 'UNKNOWN_ERROR',
      error: result?.error || result?.reason,
    };
  }

  // Log deduplication for monitoring
  if (result.deduplicated) {
    console.log(`[subscription-manager] Deduplicated credit consumption for user ${userId}, video ${youtubeId}`);
  }

  return {
    success: true,
    allowed: true,
    generationId: result.generation_id,
    usedTopup: Boolean(result.used_topup),
    reason: result.reason,
    deduplicated: Boolean(result.deduplicated),
  };
}

export async function attachVideoAnalysisToGeneration(
  generationId: string,
  videoAnalysisId: string,
  options?: { client?: DatabaseClient }
): Promise<void> {
  const supabase = options?.client ?? (await createClient());

  const { error } = await supabase
    .from('video_generations')
    .update({ video_id: videoAnalysisId })
    .eq('id', generationId);

  if (error) {
    console.error('Failed to link video generation with analysis:', error);
  }
}

export async function getRemainingCredits(
  userId: string,
  options?: { client?: DatabaseClient; now?: Date }
): Promise<{ base: number; topup: number; total: number } | null> {
  const stats = await getUsageStats(userId, options);

  if (!stats) {
    return null;
  }

  return {
    base: stats.baseRemaining,
    topup: stats.topupRemaining,
    total: stats.totalRemaining,
  };
}

export async function addTopupCredits(
  userId: string,
  amount: number,
  options?: { client?: DatabaseClient }
): Promise<{ success: boolean; error?: string }> {
  if (amount <= 0) {
    return { success: false, error: 'INVALID_AMOUNT' };
  }

  const supabase = options?.client ?? (await createClient());

  const { error } = await supabase.rpc('increment_topup_credits', {
    p_user_id: userId,
    p_amount: amount,
  });

  if (error) {
    console.error('increment_topup_credits RPC failed, falling back to manual update:', error);

    const { data: profile, error: fetchError } = await supabase
      .from('profiles')
      .select('topup_credits')
      .eq('id', userId)
      .maybeSingle();

    if (fetchError || !profile) {
      console.error('Error fetching profile for manual top-up:', fetchError);
      return { success: false, error: 'PROFILE_NOT_FOUND' };
    }

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ topup_credits: (profile.topup_credits ?? 0) + amount })
      .eq('id', userId);

    if (updateError) {
      console.error('Failed to update top-up credits manually:', updateError);
      return { success: false, error: 'TOPUP_UPDATE_FAILED' };
    }
  }

  return { success: true };
}

export async function createOrRetrieveStripeCustomer(
  userId: string,
  email: string
): Promise<{ customerId: string; error?: string }> {
  const stripe = getStripeClient();

  // Stripe not configured - payment features disabled
  if (!stripe) {
    return { customerId: '', error: 'STRIPE_NOT_CONFIGURED' };
  }

  const supabase = await createClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id, email')
    .eq('id', userId)
    .maybeSingle();

  if (profile?.stripe_customer_id) {
    return { customerId: profile.stripe_customer_id };
  }

  try {
    const customer = await stripe.customers.create({
      email: email || profile?.email,
      metadata: {
        supabase_user_id: userId,
      },
    });

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ stripe_customer_id: customer.id })
      .eq('id', userId);

    if (updateError) {
      console.error('Failed to persist Stripe customer ID:', updateError);
    }

    return { customerId: customer.id };
  } catch (error) {
    console.error('Error creating Stripe customer:', error);
    return { customerId: '', error: 'FAILED_TO_CREATE_CUSTOMER' };
  }
}

export async function hasProSubscription(userId: string): Promise<boolean> {
  const subscription = await getUserSubscriptionStatus(userId);
  return subscription?.tier === 'pro' && subscription.status === 'active';
}

export function mapStripeSubscriptionToProfileUpdate(
  subscription: Stripe.Subscription
): ProfilesUpdate {
  const currentPeriodStart = (subscription as Stripe.Subscription & {
    current_period_start?: number | null;
  }).current_period_start;

  const currentPeriodEnd = (subscription as Stripe.Subscription & {
    current_period_end?: number | null;
  }).current_period_end;

  const periodStart = currentPeriodStart
    ? new Date(currentPeriodStart * 1000).toISOString()
    : null;
  const periodEnd = currentPeriodEnd
    ? new Date(currentPeriodEnd * 1000).toISOString()
    : null;

  return {
    stripe_subscription_id: subscription.id,
    subscription_tier: 'pro',
    subscription_status: (subscription.status as SubscriptionStatus) ?? null,
    subscription_current_period_start: periodStart,
    subscription_current_period_end: periodEnd,
    cancel_at_period_end: subscription.cancel_at_period_end ?? false,
  };
}

async function isVideoCached(youtubeId: string, client: DatabaseClient): Promise<boolean> {
  const { data, error } = await client
    .from('video_analyses')
    .select('id')
    .eq('youtube_id', youtubeId)
    .maybeSingle();

  if (error) {
    console.error('Failed to check video cache status:', error);
    return false;
  }

  return Boolean(data);
}
