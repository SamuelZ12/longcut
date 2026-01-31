import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { withSecurity } from '@/lib/security-middleware';
import { getStripeClient } from '@/lib/stripe-client';
import { resolveAppUrl } from '@/lib/utils';

/**
 * POST /api/stripe/create-portal-session
 *
 * Creates a Stripe Customer Portal session for managing subscription
 * Users can update payment methods, view invoices, and cancel subscriptions
 *
 * Response:
 * {
 *   url: string  // Stripe Customer Portal URL
 * }
 */
async function handler(req: NextRequest) {
  try {
    // Auth is already validated by middleware, just get user for profile query
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

    // Fetch only the Stripe customer ID (PERFORMANCE OPTIMIZATION)
    // This replaces getUserSubscriptionStatus() which fetches entire subscription object
    // Saves ~50-100ms by querying single field instead of 10+ fields
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile?.stripe_customer_id) {
      return NextResponse.json(
        {
          error: 'No subscription found',
          message: 'You need to subscribe first before accessing the billing portal',
        },
        { status: 404 }
      );
    }

    // Get the origin from the request to ensure redirects work on preview deployments
    const origin = req.headers.get('origin') || req.headers.get('referer')?.split('?')[0].replace(/\/$/, '') || '';
    const appUrl = resolveAppUrl(origin);

    // Create Stripe billing portal session
    const stripe = getStripeClient();
    if (!stripe) {
      return NextResponse.json(
        { error: 'Payment system not configured' },
        { status: 503 }
      );
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${appUrl}/settings`,
    });

    return NextResponse.json({
      url: portalSession.url,
    });
  } catch (error) {
    // Handle Stripe errors
    if (error && typeof error === 'object' && 'type' in error) {
      const stripeError = error as any;
      console.error('Stripe error:', stripeError);

      // Check if it's a portal configuration error
      if (
        stripeError.type === 'StripeInvalidRequestError' &&
        stripeError.message?.includes('No configuration')
      ) {
        // Determine if we're in test mode
        const isTestMode = process.env.STRIPE_SECRET_KEY?.includes('_test_');
        const dashboardUrl = isTestMode
          ? 'https://dashboard.stripe.com/test/settings/billing/portal'
          : 'https://dashboard.stripe.com/settings/billing/portal';

        return NextResponse.json(
          {
            error: 'Customer Portal not configured',
            message:
              'The Stripe Customer Portal needs to be set up before you can manage your billing. ' +
              'Please contact support or run the setup script: npm run stripe:setup-portal',
            setupUrl: dashboardUrl,
            isConfigError: true,
          },
          { status: 500 }
        );
      }

      // Generic Stripe error
      return NextResponse.json(
        {
          error: 'Unable to access billing portal',
          message: 'There was an error accessing the billing portal. Please try again.',
        },
        { status: 500 }
      );
    }

    console.error('Error creating portal session:', error);
    return NextResponse.json(
      { error: 'Failed to create billing portal session' },
      { status: 500 }
    );
  }
}

// Use custom security config without rate limiting for better performance (~100ms savings)
// Billing portal is low-risk: auth + CSRF protection is sufficient, Stripe handles actual operations
export const POST = withSecurity(handler, {
  requireAuth: true,
  csrfProtection: true,
  maxBodySize: 1024,
  allowedMethods: ['POST'],
  // rateLimit: intentionally omitted for performance
});
