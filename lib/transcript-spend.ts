import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { canGenerateVideo } from '@/lib/subscription-manager';
import { hasUnlimitedVideoAllowance } from '@/lib/access-control';
import { getGuestAccessState, type GuestAccessState } from '@/lib/guest-usage';
import { dependencyUnavailable } from '@/lib/dependency-unavailable';
import { supadataNativeCacheIdentity } from '@/lib/supadata-transcript-provider';

// Explicit opt-in to the approved matrix, also enforced by the database RPC.
// No defaults and no caller-supplied numerical limits. This policy covers ONLY native transcripts.
export const TRANSCRIPT_SPEND_POLICY = 'native-v1';
type Tier = 'guest' | 'free' | 'topup' | 'pro' | 'unlimited';
export type TranscriptEligibility =
  | { allowed: true; tier: Tier; identifiers: string[]; guest?: GuestAccessState }
  | { allowed: false; reason: string; requiresAuth: boolean; guest?: GuestAccessState };

/** Eligibility is read-only: never consume customer credits or mark a guest analysis used. */
export async function transcriptEligibility(): Promise<TranscriptEligibility> {
  const client = await createClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error && error.name !== 'AuthSessionMissingError') throw dependencyUnavailable('auth', error);
  if (!user) {
    const guest = await getGuestAccessState();
    return guest.used
      ? { allowed: false, reason: 'AUTH_REQUIRED', requiresAuth: true, guest }
      : { allowed: true, tier: 'guest', identifiers: guest.identifiers, guest };
  }
  const identifiers = [`user:${user.id}`];
  if (hasUnlimitedVideoAllowance(user)) return { allowed: true, tier: 'unlimited', identifiers };
  const decision = await canGenerateVideo(user.id, undefined, { client, skipCacheCheck: true });
  if (!decision.allowed) return { allowed: false, reason: decision.reason, requiresAuth: false };
  const tier = decision.subscription?.tier === 'pro' ? 'pro'
    : (decision.subscription?.topupCredits ?? 0) > 0 ? 'topup' : 'free';
  return { allowed: true, tier, identifiers };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(name, args);
    if (error) throw error;
    return data;
  } catch (error) { throw dependencyUnavailable('transcript-spend', error); }
}

export type SpendAdmission = { allowed: true; reservationId: string } |
  { allowed: false; reason: 'budget' | 'concurrency' | 'cooldown' | 'guest_used'; resetAt: string };

export async function reserveTranscriptSpend(
  identity: Extract<TranscriptEligibility, { allowed: true }>, videoId: string, lang?: string,
): Promise<SpendAdmission> {
  if (process.env.SUPADATA_SPEND_POLICY !== TRANSCRIPT_SPEND_POLICY) {
    throw dependencyUnavailable('transcript-spend-config');
  }
  const data = await rpc('reserve_transcript_spend', {
    p_policy: TRANSCRIPT_SPEND_POLICY, p_tier: identity.tier, p_identifiers: identity.identifiers,
    p_key: supadataNativeCacheIdentity(videoId, lang?.toLowerCase()),
  }) as Record<string, unknown> | null;
  if (data?.allowed === true && typeof data.reservation_id === 'string') {
    return { allowed: true, reservationId: data.reservation_id };
  }
  if (data?.allowed === false && ['budget', 'concurrency', 'cooldown', 'guest_used'].includes(String(data.reason))
    && typeof data.retry_at === 'string' && Number.isFinite(Date.parse(data.retry_at))) {
    return { allowed: false, reason: data.reason as 'budget' | 'concurrency' | 'cooldown' | 'guest_used', resetAt: data.retry_at };
  }
  throw dependencyUnavailable('transcript-spend-response');
}

/** Only reserved, demonstrably undispatched attempts can be released. Lost acknowledgements fail closed. */
export async function transitionTranscriptSpend(id: string, action: 'dispatch' | 'release' | 'complete' | 'uncertain'): Promise<void> {
  if (await rpc('transition_transcript_spend', { p_id: id, p_action: action }) !== true) {
    throw dependencyUnavailable('transcript-spend-transition');
  }
}
