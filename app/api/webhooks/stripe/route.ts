import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripeClient } from '@/lib/stripe-client';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { mapStripeSubscriptionToProfileUpdate } from '@/lib/subscription-manager';
import { processTopupCheckout, processTranscriptionTopupCheckout } from '@/lib/stripe-topup';
import { AuditLogger, AuditAction } from '@/lib/audit-logger';
import type { ProfilesUpdate } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DUPLICATE_EVENT_CODE = '23505';

async function handler(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('❌ STRIPE_WEBHOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  const supabase = createServiceRoleClient();
  const stripe = getStripeClient();
  let eventId: string | null = null;
  let eventLocked = false;

  try {
    const body = await req.text();
    const signature = req.headers.get('stripe-signature');

    console.log(`📨 Webhook request received - Body length: ${body.length} bytes`);

    if (!signature) {
      console.error('❌ Missing stripe-signature header');
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }

    console.log('🔐 Attempting to verify webhook signature...');
    const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    console.log(`✅ Signature verified successfully for event ${event.type}`);
    eventId = event.id;

    eventLocked = await lockStripeEvent(event.id, supabase);
    if (!eventLocked) {
      console.log(`Stripe event ${event.id} already processed. Skipping.`);
      return NextResponse.json({ received: true });
    }

    console.log(`Received Stripe webhook: ${event.type} (${event.id})`);
    await dispatchStripeEvent(event, supabase, stripe);

    console.log(`✅ Successfully processed Stripe webhook: ${event.type} (${event.id})`);
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    console.error('Error details:', error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack
    } : error);

    if (eventLocked && eventId) {
      console.log(`🔓 Releasing event lock for ${eventId}`);
      await releaseStripeEvent(eventId, supabase);
    }

    // If it's a signature validation error, return 400 (don't retry)
    if (error instanceof Error && error.message.includes('signature')) {
      console.error('❌ Signature validation failed - this indicates a webhook secret mismatch or body tampering');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // For other errors, return 500 so Stripe retries the webhook
    console.error('❌ Webhook processing failed - Stripe will retry');
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

async function dispatchStripeEvent(
  event: Stripe.Event,
  supabase: SupabaseClient<any, string, any>,
  stripe: Stripe
) {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, supabase, stripe);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription, supabase);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription, supabase);
      break;
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice, supabase);
      break;
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice, supabase);
      break;
    default:
      console.log(`Unhandled Stripe event type: ${event.type}`);
  }
}

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  supabase: SupabaseClient<any, string, any>,
  stripe: Stripe
) {
  const userId = session.metadata?.userId;

  if (!userId) {
    console.error('No userId metadata on checkout session');
    return;
  }

  if (session.mode === 'subscription' && session.subscription) {
    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    const updatePayload = {
      ...mapStripeSubscriptionToProfileUpdate(subscription),
      stripe_customer_id: session.customer as string,
    } satisfies ProfilesUpdate;

    const { error, count } = await (supabase.from('profiles') as any)
      .update(updatePayload)
      .eq('id', userId)
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.error('Failed to update subscription after checkout:', error);
      throw new Error(`Database update failed for subscription ${subscriptionId}: ${error.message}`);
    }

    if (count === 0) {
      console.error(`⚠️ Profile not found for user ${userId} during checkout completion`);
      throw new Error(`Profile not found for user ${userId}. This webhook will retry automatically.`);
    }

    const subscriptionPeriods = subscription as {
      current_period_start?: number | null;
      current_period_end?: number | null;
    };

    console.log(`✅ Successfully activated Pro subscription for user ${userId}`);
    console.log(`   - Subscription ID: ${subscriptionId}`);
    console.log(`   - Status: ${subscription.status}`);
    console.log(
      `   - Period: ${
        subscriptionPeriods.current_period_start
          ? new Date(subscriptionPeriods.current_period_start * 1000).toISOString()
          : 'unknown'
      } to ${
        subscriptionPeriods.current_period_end
          ? new Date(subscriptionPeriods.current_period_end * 1000).toISOString()
          : 'unknown'
      }`
    );

    await AuditLogger.log({
      userId,
      action: AuditAction.SUBSCRIPTION_CREATED,
      resourceType: 'subscription',
      resourceId: subscriptionId,
      details: { tier: 'pro', status: subscription.status },
    }, supabase);
  }

  if (session.mode === 'payment') {
    // Handle video credit top-ups
    const topupResult = await processTopupCheckout(session, supabase);

    if (topupResult) {
      if (topupResult.alreadyApplied) {
        console.log('ℹ️ Top-up credits already applied for this payment intent, skipping duplicate log.');
      } else {
        console.log(
          `✅ Successfully added ${topupResult.creditsAdded} top-up credits for user ${userId}`
        );
        await AuditLogger.log({
          userId,
          action: AuditAction.TOPUP_PURCHASED,
          resourceType: 'topup',
          resourceId:
            typeof session.payment_intent === 'string'
              ? session.payment_intent
              : session.payment_intent?.id ?? 'unknown',
          details: { credits: topupResult.creditsAdded, totalCredits: topupResult.totalCredits },
        }, supabase);
      }
    }

    // Handle transcription minutes top-ups
    const transcriptionTopupResult = await processTranscriptionTopupCheckout(session, supabase);

    if (transcriptionTopupResult) {
      if (transcriptionTopupResult.alreadyApplied) {
        console.log('ℹ️ Transcription minutes already applied for this payment intent, skipping duplicate log.');
      } else {
        console.log(
          `✅ Successfully added ${transcriptionTopupResult.minutesAdded} transcription minutes for user ${userId}`
        );
        await AuditLogger.log({
          userId,
          action: AuditAction.TOPUP_PURCHASED,
          resourceType: 'transcription_topup',
          resourceId:
            typeof session.payment_intent === 'string'
              ? session.payment_intent
              : session.payment_intent?.id ?? 'unknown',
          details: {
            minutes: transcriptionTopupResult.minutesAdded,
            totalMinutes: transcriptionTopupResult.totalMinutes,
          },
        }, supabase);
      }
    }
  }
}

async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
  supabase: SupabaseClient<any, string, any>
) {
  const userId = await resolveUserIdFromSubscription(subscription, supabase);

  if (!userId) {
    console.error('Unable to resolve user for subscription update:', subscription.id);
    return;
  }

  const updatePayload = mapStripeSubscriptionToProfileUpdate(subscription) as ProfilesUpdate;

  const { error, count } = await (supabase.from('profiles') as any)
    .update(updatePayload)
    .eq('id', userId)
    .select('*', { count: 'exact', head: true });

  if (error) {
    console.error('Failed to sync subscription update:', error);
    throw new Error(`Failed to sync subscription update: ${error.message}`);
  }

  if (count === 0) {
    console.error(`⚠️ Profile not found for user ${userId} during subscription update`);
    throw new Error(`Profile not found for user ${userId}. This webhook will retry automatically.`);
  }

  console.log(`✅ Successfully updated subscription ${subscription.id} for user ${userId}`);
  await AuditLogger.log({
    userId,
    action: AuditAction.SUBSCRIPTION_UPDATED,
    resourceType: 'subscription',
    resourceId: subscription.id,
    details: {
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    },
  }, supabase);
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  supabase: SupabaseClient<any, string, any>
) {
  const userId = await resolveUserIdFromSubscription(subscription, supabase);

  if (!userId) {
    console.error('Unable to resolve user for canceled subscription:', subscription.id);
    return;
  }

  const downgradePayload = {
    subscription_tier: 'free',
    subscription_status: null,
    stripe_subscription_id: null,
    subscription_current_period_start: null,
    subscription_current_period_end: null,
    cancel_at_period_end: false,
  } satisfies ProfilesUpdate;

  const { error } = await (supabase.from('profiles') as any)
    .update(downgradePayload)
    .eq('id', userId);

  if (error) {
    console.error('Failed to downgrade user after cancellation:', error);
    throw new Error(`Failed to downgrade user after cancellation: ${error.message}`);
  }

  console.log(`✅ Successfully downgraded user ${userId} to free tier after subscription ${subscription.id} cancellation`);
  await AuditLogger.log({
    userId,
    action: AuditAction.SUBSCRIPTION_CANCELED,
    resourceType: 'subscription',
    resourceId: subscription.id,
    details: { downgradedToFree: true },
  }, supabase);
}

async function handleInvoicePaymentSucceeded(
  invoice: Stripe.Invoice,
  supabase: SupabaseClient<any, string, any>
) {
  const { subscriptionId, customerId } = extractInvoiceRefs(invoice);

  if (!subscriptionId && !customerId) {
    return;
  }

  let userId: string | null = null;
  if (subscriptionId) {
    userId = await getUserIdBySubscription(subscriptionId, supabase);
  }
  if (!userId && customerId) {
    userId = await getUserIdByCustomer(customerId, supabase);
  }

  if (!userId) {
    console.error('Unable to resolve user for invoice:', invoice.id);
    return;
  }

  const activatePayload = { subscription_status: 'active' } satisfies ProfilesUpdate;

  const { error } = await (supabase.from('profiles') as any)
    .update(activatePayload)
    .eq('id', userId);

  if (error) {
    console.error('Failed to mark subscription as active:', error);
    throw new Error(`Failed to mark subscription as active: ${error.message}`);
  }

  console.log(`✅ Successfully marked subscription as active for user ${userId} after invoice ${invoice.id} payment`);
}

async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  supabase: SupabaseClient<any, string, any>
) {
  const { subscriptionId, customerId } = extractInvoiceRefs(invoice);

  if (!subscriptionId && !customerId) {
    return;
  }

  let userId: string | null = null;
  if (subscriptionId) {
    userId = await getUserIdBySubscription(subscriptionId, supabase);
  }
  if (!userId && customerId) {
    userId = await getUserIdByCustomer(customerId, supabase);
  }

  if (!userId) {
    console.error('Unable to resolve user for failed invoice:', invoice.id);
    return;
  }

  const pastDuePayload = { subscription_status: 'past_due' } satisfies ProfilesUpdate;

  const { error } = await (supabase.from('profiles') as any)
    .update(pastDuePayload)
    .eq('id', userId);

  if (error) {
    console.error('Failed to mark subscription as past_due:', error);
    throw new Error(`Failed to mark subscription as past_due: ${error.message}`);
  }

  console.log(`✅ Successfully marked subscription as past_due for user ${userId} after invoice ${invoice.id} payment failed`);
  await AuditLogger.log({
    userId,
    action: AuditAction.PAYMENT_FAILED,
    resourceType: 'invoice',
    resourceId: invoice.id,
    details: { subscriptionId },
  }, supabase);
}

async function getUserIdBySubscription(
  subscriptionId: string,
  supabase: SupabaseClient<any, string, any>
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();

  if (error) {
    console.error('Failed to locate user by subscription:', error);
    return null;
  }

  return data?.id ?? null;
}

async function getUserIdByCustomer(
  customerId: string,
  supabase: SupabaseClient<any, string, any>
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (error) {
    console.error('Failed to locate user by customer:', error);
    return null;
  }

  return data?.id ?? null;
}

function extractInvoiceRefs(invoice: Stripe.Invoice): { subscriptionId: string | null; customerId: string | null } {
  const subscriptionRef = (invoice as Stripe.Invoice & {
    subscription?: string | Stripe.Subscription | null;
  }).subscription;

  const customerRef = invoice.customer;

  const subscriptionId = subscriptionRef
    ? typeof subscriptionRef === 'string'
      ? subscriptionRef
      : subscriptionRef.id
    : null;

  const customerId = customerRef
    ? typeof customerRef === 'string'
      ? customerRef
      : customerRef.id
    : null;

  return { subscriptionId, customerId };
}

async function resolveUserIdFromSubscription(
  subscription: Stripe.Subscription,
  supabase: SupabaseClient<any, string, any>
): Promise<string | null> {
  if (subscription.metadata?.userId) {
    return subscription.metadata.userId;
  }

  const bySubscription = await getUserIdBySubscription(subscription.id, supabase);
  if (bySubscription) {
    return bySubscription;
  }

  const customerRef = subscription.customer;
  const customerId = typeof customerRef === 'string' ? customerRef : customerRef?.id ?? null;

  if (!customerId) {
    return null;
  }

  return getUserIdByCustomer(customerId, supabase);
}

async function lockStripeEvent(eventId: string, supabase: SupabaseClient<any, string, any>): Promise<boolean> {
  const { error } = await supabase
    .from('stripe_events')
    .insert({ event_id: eventId });

  if (!error) {
    return true;
  }

  if ('code' in error && error.code === DUPLICATE_EVENT_CODE) {
    return false;
  }

  throw error;
}

async function releaseStripeEvent(eventId: string, supabase: SupabaseClient<any, string, any>): Promise<void> {
  const { error } = await supabase
    .from('stripe_events')
    .delete()
    .eq('event_id', eventId);

  if (error) {
    console.error('Failed to release Stripe event lock:', error);
  }
}

export const POST = handler;
