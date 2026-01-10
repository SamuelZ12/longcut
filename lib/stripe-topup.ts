import type { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

import { getStripeClient } from '@/lib/stripe-client';
import { addTopupCredits } from '@/lib/subscription-manager';
import { addTranscriptionTopupCredits, TRANSCRIPTION_TOPUP_MINUTES } from '@/lib/transcription-manager';

export interface TopupValues {
  credits: number;
  amountCents: number;
}

export interface TranscriptionTopupValues {
  minutes: number;
  amountCents: number;
}

export interface TopupProcessingResult {
  creditsAdded: number;
  totalCredits: number | null;
  alreadyApplied: boolean;
}

export interface TranscriptionTopupProcessingResult {
  minutesAdded: number;
  totalMinutes: number | null;
  alreadyApplied: boolean;
}

const DEFAULT_CREDITS = 20;
const DEFAULT_AMOUNT_CENTS = 299;
const DUPLICATE_EVENT_CODE = '23505';

function normalizePaymentIntentId(
  paymentIntent: Stripe.Checkout.Session['payment_intent']
): string | null {
  if (!paymentIntent) {
    return null;
  }

  if (typeof paymentIntent === 'string') {
    return paymentIntent;
  }

  return paymentIntent.id ?? null;
}

export async function extractTopupValuesFromSession(
  session: Stripe.Checkout.Session
): Promise<TopupValues> {
  const stripe = getStripeClient();

  try {
    const sessionWithItems =
      session.line_items?.data?.length && session.line_items.data[0]?.price
        ? session
        : await stripe.checkout.sessions.retrieve(session.id, {
            expand: ['line_items', 'line_items.data.price'],
          });

    const lineItem = sessionWithItems.line_items?.data?.[0];

    if (!lineItem || !lineItem.price) {
      console.warn('No line items found in checkout session, using defaults');
      return { credits: DEFAULT_CREDITS, amountCents: DEFAULT_AMOUNT_CENTS };
    }

    const price = lineItem.price as Stripe.Price;
    const creditsFromMetadata =
      price.metadata && typeof price.metadata.credits === 'string'
        ? parseInt(price.metadata.credits, 10)
        : NaN;

    const credits = Number.isFinite(creditsFromMetadata)
      ? creditsFromMetadata
      : DEFAULT_CREDITS;

    const amountCents =
      typeof price.unit_amount === 'number' ? price.unit_amount : DEFAULT_AMOUNT_CENTS;

    return { credits, amountCents };
  } catch (error) {
    console.error('Failed to extract top-up values from Stripe, using defaults:', error);
    return { credits: DEFAULT_CREDITS, amountCents: DEFAULT_AMOUNT_CENTS };
  }
}

type DatabaseClient = SupabaseClient<any, string, any>;

export async function processTopupCheckout(
  session: Stripe.Checkout.Session,
  supabase: DatabaseClient
): Promise<TopupProcessingResult | null> {
  const userId = session.metadata?.userId;

  if (!userId) {
    console.error('Unable to process top-up: missing userId metadata');
    return null;
  }

  const paymentIntentId = normalizePaymentIntentId(session.payment_intent ?? null);

  if (!paymentIntentId) {
    console.error('Unable to process top-up: missing payment intent');
    return null;
  }

  if (session.metadata?.priceType !== 'topup') {
    return null;
  }

  const { credits, amountCents } = await extractTopupValuesFromSession(session);

  const insertResult = await supabase
    .from('topup_purchases')
    .insert({
      user_id: userId,
      stripe_payment_intent_id: paymentIntentId,
      credits_purchased: credits,
      amount_paid: amountCents,
    })
    .select('id')
    .maybeSingle();

  if (insertResult.error) {
    const error = insertResult.error;

    if ('code' in error && error.code === DUPLICATE_EVENT_CODE) {
      console.log(`Top-up purchase already recorded for payment intent ${paymentIntentId}`);
      const { data: profile } = await supabase
        .from('profiles')
        .select('topup_credits')
        .eq('id', userId)
        .maybeSingle();

      return {
        creditsAdded: 0,
        totalCredits: profile?.topup_credits ?? null,
        alreadyApplied: true,
      };
    }

    console.error('Failed to store top-up purchase:', error);
    throw new Error(`Failed to store top-up purchase: ${error.message}`);
  }

  const insertedId = insertResult.data?.id ?? null;
  const addResult = await addTopupCredits(userId, credits, { client: supabase });

  if (!addResult.success) {
    console.error('Failed to add top-up credits:', addResult.error);

    if (insertedId) {
      await supabase.from('topup_purchases').delete().eq('id', insertedId);
    }

    throw new Error(`Failed to add top-up credits: ${addResult.error}`);
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('topup_credits')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) {
    console.error('Failed to fetch updated top-up credits:', profileError);
  }

  return {
    creditsAdded: credits,
    totalCredits: profile?.topup_credits ?? null,
    alreadyApplied: false,
  };
}

/**
 * Extract transcription minutes from Stripe checkout session
 */
export async function extractTranscriptionTopupValuesFromSession(
  session: Stripe.Checkout.Session
): Promise<TranscriptionTopupValues> {
  const stripe = getStripeClient();

  try {
    const sessionWithItems =
      session.line_items?.data?.length && session.line_items.data[0]?.price
        ? session
        : await stripe.checkout.sessions.retrieve(session.id, {
            expand: ['line_items', 'line_items.data.price'],
          });

    const lineItem = sessionWithItems.line_items?.data?.[0];

    if (!lineItem || !lineItem.price) {
      console.warn('No line items found in checkout session, using default transcription minutes');
      return { minutes: TRANSCRIPTION_TOPUP_MINUTES, amountCents: 299 };
    }

    const price = lineItem.price as Stripe.Price;
    const minutesFromMetadata =
      price.metadata && typeof price.metadata.minutes === 'string'
        ? parseInt(price.metadata.minutes, 10)
        : NaN;

    const minutes = Number.isFinite(minutesFromMetadata)
      ? minutesFromMetadata
      : TRANSCRIPTION_TOPUP_MINUTES;

    const amountCents =
      typeof price.unit_amount === 'number' ? price.unit_amount : 299;

    return { minutes, amountCents };
  } catch (error) {
    console.error('Failed to extract transcription top-up values from Stripe, using defaults:', error);
    return { minutes: TRANSCRIPTION_TOPUP_MINUTES, amountCents: 299 };
  }
}

/**
 * Process a transcription minutes top-up checkout
 */
export async function processTranscriptionTopupCheckout(
  session: Stripe.Checkout.Session,
  supabase: DatabaseClient
): Promise<TranscriptionTopupProcessingResult | null> {
  const userId = session.metadata?.userId;

  if (!userId) {
    console.error('Unable to process transcription top-up: missing userId metadata');
    return null;
  }

  const paymentIntentId = normalizePaymentIntentId(session.payment_intent ?? null);

  if (!paymentIntentId) {
    console.error('Unable to process transcription top-up: missing payment intent');
    return null;
  }

  if (session.metadata?.priceType !== 'transcription_topup') {
    return null;
  }

  const { minutes, amountCents } = await extractTranscriptionTopupValuesFromSession(session);

  // Use the atomic RPC function which handles idempotency
  const result = await addTranscriptionTopupCredits(
    userId,
    paymentIntentId,
    minutes,
    amountCents,
    { client: supabase }
  );

  if (!result.success) {
    console.error('Failed to add transcription top-up credits:', result.error);
    throw new Error(`Failed to add transcription top-up credits: ${result.error}`);
  }

  return {
    minutesAdded: result.alreadyProcessed ? 0 : minutes,
    totalMinutes: result.newBalance ?? null,
    alreadyApplied: result.alreadyProcessed ?? false,
  };
}
