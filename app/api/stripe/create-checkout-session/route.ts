import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { withSecurity } from '@/lib/security-middleware';
import { getStripeClient, STRIPE_PRICE_IDS } from '@/lib/stripe-client';
import {
  createOrRetrieveStripeCustomer,
} from '@/lib/subscription-manager';
import { formatValidationError } from '@/lib/validation';
import { resolveAppUrl } from '@/lib/utils';

/**
 * Request schema for creating a checkout session
 */
const createCheckoutSessionSchema = z.object({
  priceType: z.enum(['subscription', 'subscription_annual', 'topup']),
  currency: z.enum(['usd', 'cny']).optional().default('usd'), // Optional currency selection for top-ups
});

/**
 * POST /api/stripe/create-checkout-session
 *
 * Creates a Stripe Checkout session for Pro subscription or Top-Up credits purchase
 *
 * Request body:
 * {
 *   priceType: 'subscription' | 'topup'
 * }
 *
 * Response:
 * {
 *   url: string  // Stripe Checkout hosted page URL
 * }
 */
async function handler(req: NextRequest) {
  // Declare variables outside try block so they're accessible in catch block
  let priceId: string | undefined;
  let validatedData: z.infer<typeof createCheckoutSessionSchema> | undefined;

  try {
    // Get authenticated user
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Fetch all needed profile data in a single query (PERFORMANCE OPTIMIZATION)
    // This replaces 3-4 sequential queries with 1 batched query, saving ~150-200ms
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('email, subscription_tier, subscription_status, stripe_customer_id, subscription_current_period_end, cancel_at_period_end, stripe_subscription_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.error('Failed to fetch profile:', profileError);
      return NextResponse.json(
        { error: 'User profile not found' },
        { status: 404 }
      );
    }

    const userEmail = user.email || profile.email;

    if (!userEmail) {
      return NextResponse.json(
        { error: 'User email not found' },
        { status: 400 }
      );
    }

    // Validate request body
    const body = await req.json();
    validatedData = createCheckoutSessionSchema.parse(body);

    // Create or retrieve Stripe customer (using batched data)
    let customerId = profile.stripe_customer_id;

    // Only create new Stripe customer if one doesn't exist
    if (!customerId) {
      const { customerId: newCustomerId, error: customerError } = await createOrRetrieveStripeCustomer(
        user.id,
        userEmail
      );

      if (customerError || !newCustomerId) {
        console.error('Failed to create Stripe customer:', customerError);
        return NextResponse.json(
          { error: 'Unable to process payment setup' },
          { status: 500 }
        );
      }

      customerId = newCustomerId;
    }

    // Determine the price ID and mode based on priceType
    const isSubscription =
      validatedData.priceType === 'subscription' || validatedData.priceType === 'subscription_annual';

    // Select the appropriate price ID
    switch (validatedData.priceType) {
      case 'subscription':
        priceId = STRIPE_PRICE_IDS.PRO_SUBSCRIPTION;
        break;
      case 'subscription_annual':
        priceId = STRIPE_PRICE_IDS.PRO_SUBSCRIPTION_ANNUAL;
        break;
      case 'topup':
        // For top-ups, select price based on currency
        if (validatedData.currency === 'cny' && STRIPE_PRICE_IDS.TOPUP_CREDITS_CNY) {
          priceId = STRIPE_PRICE_IDS.TOPUP_CREDITS_CNY;
        } else {
          priceId = STRIPE_PRICE_IDS.TOPUP_CREDITS;
        }
        break;
    }

    const mode = isSubscription ? 'subscription' : 'payment';

    // Debug logging
    console.log('Creating checkout session:', {
      priceType: validatedData.priceType,
      currency: validatedData.currency,
      priceId,
      mode,
      userId: user.id,
    });

    // Validate price ID exists
    if (!priceId) {
      const errorMessage = validatedData.priceType === 'subscription_annual'
        ? 'Annual subscription price not configured. Please check STRIPE_PRO_ANNUAL_PRICE_ID environment variable.'
        : `Price ID not configured for ${validatedData.priceType}`;
      console.error(errorMessage);
      return NextResponse.json(
        { error: 'Subscription configuration error. Please contact support.' },
        { status: 500 }
      );
    }

    // Get the origin from the request to ensure redirects work on preview deployments
    const origin = req.headers.get('origin') || req.headers.get('referer')?.split('?')[0].replace(/\/$/, '') || '';
    const appUrl = resolveAppUrl(origin);

    // Check if user has a canceled subscription that's still active
    const isCanceled = profile.subscription_status === 'canceled' || profile.cancel_at_period_end;
    const currentPeriodEnd = profile.subscription_current_period_end
      ? new Date(profile.subscription_current_period_end)
      : null;
    const periodEndInFuture = currentPeriodEnd && currentPeriodEnd > new Date();

    // For canceled subscriptions with remaining time, we'll use subscription_schedule
    // to start the new subscription when the old one ends
    let scheduleNewSubscription = false;
    let trialEndTimestamp: number | undefined;

    if (isSubscription && isCanceled && periodEndInFuture && currentPeriodEnd) {
      scheduleNewSubscription = true;
      // Convert to Unix timestamp for Stripe (seconds, not milliseconds)
      trialEndTimestamp = Math.floor(currentPeriodEnd.getTime() / 1000);
      console.log('Scheduling new subscription to start at period end:', {
        subscriptionId: profile.stripe_subscription_id,
        periodEnd: currentPeriodEnd,
        trialEndTimestamp,
      });
    }

    // Create Stripe Checkout session
    const stripe = getStripeClient();
    if (!stripe) {
      return NextResponse.json(
        { error: 'Payment system not configured' },
        { status: 503 }
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: mode,
      // Conditionally set payment methods based on mode
      // Alipay and WeChat Pay only support one-time payments, not subscriptions
      payment_method_types: mode === 'subscription'
        ? ['card']  // Subscriptions: cards only
        : ['card', 'alipay', 'wechat_pay'],  // Topups: cards + Alipay + WeChat Pay
      // Configure payment method options for WeChat Pay
      // WeChat Pay requires explicit client type for web applications
      ...(mode === 'payment' && {
        payment_method_options: {
          wechat_pay: {
            client: 'web',  // Display QR code for web-based payments
          },
        },
      }),
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${appUrl}/settings?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/settings?canceled=true`,
      metadata: {
        userId: user.id,
        priceType: validatedData.priceType,
      },
      // Allow promotion codes
      allow_promotion_codes: true,
      // For subscriptions, configure subscription data
      ...(mode === 'subscription' && {
        subscription_data: {
          metadata: {
            userId: user.id,
            billingPeriod: validatedData.priceType === 'subscription_annual' ? 'annual' : 'monthly',
          },
          // If user has canceled subscription, use trial_end to start new subscription
          // at the end of their current period
          ...(scheduleNewSubscription && trialEndTimestamp && {
            trial_end: trialEndTimestamp,
          }),
        },
      }),
    });

    return NextResponse.json({
      url: session.url,
    });
  } catch (error) {
    // Handle validation errors
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: formatValidationError(error),
        },
        { status: 400 }
      );
    }

    // Handle Stripe errors
    if (error && typeof error === 'object' && 'type' in error) {
      const stripeError = error as any;
      console.error('Stripe API error:', {
        type: stripeError.type,
        code: stripeError.code,
        message: stripeError.message,
        param: stripeError.param,
        requestId: stripeError.requestId,
      });

      // Provide more specific error messages for common issues
      let errorMessage = 'Payment processing error. Please try again.';

      if (stripeError.code === 'resource_missing') {
        const isTestKey = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_');
        const mode = isTestKey ? 'test' : 'live';

        console.error('❌ Stripe Price ID Not Found:', {
          priceId,
          priceType: validatedData?.priceType,
          stripeMode: mode,
          error: stripeError.message,
          hint: `The price ID '${priceId}' does not exist in ${mode} mode. Check your .env.local configuration.`,
        });

        // Check if the error message mentions mode mismatch
        if (stripeError.message?.includes('similar object exists in')) {
          const oppositeMode = isTestKey ? 'live' : 'test';
          errorMessage = `Configuration error: This price exists in ${oppositeMode} mode, but you're using ${mode} mode keys. Please update your environment variables to use the correct price IDs for ${mode} mode.`;
        } else {
          errorMessage = 'Invalid payment configuration. The selected plan is not available. Please contact support.';
        }
      }

      return NextResponse.json(
        { error: errorMessage },
        { status: 500 }
      );
    }

    console.error('Error creating checkout session:', error);
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    );
  }
}

// Use custom security config without rate limiting for better performance (~100ms savings)
// Stripe checkout is low-risk: auth + CSRF protection is sufficient
export const POST = withSecurity(handler, {
  requireAuth: true,
  csrfProtection: true,
  maxBodySize: 1024,
  allowedMethods: ['POST'],
  // rateLimit: intentionally omitted for performance
});
