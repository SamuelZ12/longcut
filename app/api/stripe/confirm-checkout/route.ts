import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getStripeClient } from '@/lib/stripe-client';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { mapStripeSubscriptionToProfileUpdate } from '@/lib/subscription-manager';
import { processTopupCheckout, processTranscriptionTopupCheckout } from '@/lib/stripe-topup';
import type { ProfilesUpdate } from '@/lib/supabase/types';

const requestSchema = z.object({
  sessionId: z.string().min(1, 'Missing checkout session'),
});

async function handler(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId } = requestSchema.parse(body);

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });

    if (!session) {
      return NextResponse.json({ error: 'Checkout session not found' }, { status: 404 });
    }

    const sessionUserId = session.metadata?.userId;
    if (!sessionUserId || sessionUserId !== user.id) {
      return NextResponse.json({ error: 'Session does not belong to this user' }, { status: 403 });
    }

    const serviceClient = createServiceRoleClient();

    if (session.mode === 'payment' && session.metadata?.priceType === 'topup') {
      const topupResult = await processTopupCheckout(session, serviceClient);

      if (!topupResult) {
        return NextResponse.json(
          { error: 'Unable to process top-up purchase' },
          { status: 400 }
        );
      }

      return NextResponse.json({
        updated: !topupResult.alreadyApplied,
        type: 'topup',
        creditsAdded: topupResult.creditsAdded,
        totalCredits: topupResult.totalCredits,
        alreadyApplied: topupResult.alreadyApplied,
      });
    }

    // Handle transcription minutes top-up
    if (session.mode === 'payment' && session.metadata?.priceType === 'transcription_topup') {
      const result = await processTranscriptionTopupCheckout(session, serviceClient);

      if (!result) {
        return NextResponse.json(
          { error: 'Unable to process transcription top-up' },
          { status: 400 }
        );
      }

      return NextResponse.json({
        updated: !result.alreadyApplied,
        type: 'transcription_topup',
        minutesAdded: result.minutesAdded,
        totalMinutes: result.totalMinutes,
        alreadyApplied: result.alreadyApplied,
      });
    }

    if (session.mode !== 'subscription' || !session.subscription) {
      return NextResponse.json({ status: 'noop', updated: false, type: 'unknown' });
    }

    const subscription =
      typeof session.subscription === 'string'
        ? await stripe.subscriptions.retrieve(session.subscription)
        : session.subscription;

    if (!subscription) {
      return NextResponse.json({ error: 'Subscription details unavailable' }, { status: 404 });
    }

    const updatePayload = {
      ...mapStripeSubscriptionToProfileUpdate(subscription),
      stripe_customer_id:
        typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id ?? null,
    } satisfies ProfilesUpdate;

    const { error, count } = await (serviceClient.from('profiles') as any)
      .update(updatePayload)
      .eq('id', user.id)
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.error('Failed to persist subscription via confirmation endpoint:', error);
      return NextResponse.json({ error: 'Failed to update subscription' }, { status: 500 });
    }

    if (count === 0) {
      console.error(`⚠️ Profile not found for user ${user.id} during checkout confirmation`);
      return NextResponse.json({
        error: 'Profile not found',
        status: 'subscription_pending'
      }, { status: 404 });
    }

    const subscriptionPeriods = subscription as {
      current_period_start?: number | null;
      current_period_end?: number | null;
    };

    return NextResponse.json({
      updated: true,
      type: 'subscription',
      tier: 'pro',
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      currentPeriodStart: subscriptionPeriods.current_period_start
        ? new Date(subscriptionPeriods.current_period_start * 1000).toISOString()
        : null,
      currentPeriodEnd: subscriptionPeriods.current_period_end
        ? new Date(subscriptionPeriods.current_period_end * 1000).toISOString()
        : null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    console.error('Error confirming checkout session:', error);
    return NextResponse.json({ error: 'Failed to confirm checkout' }, { status: 500 });
  }
}

export const POST = withSecurity(handler, SECURITY_PRESETS.AUTHENTICATED);
