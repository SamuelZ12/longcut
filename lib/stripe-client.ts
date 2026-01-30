import Stripe from 'stripe';

/**
 * Lazily instantiated Stripe client for server-side operations
 * This avoids hard failures during build/deploy when secrets are missing
 * yet still surfaces a descriptive error the moment Stripe is actually used.
 */
let stripeClient: Stripe | null = null;

function createStripeClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Please add it to your .env.local file.\n' +
        'Get your test key from: https://dashboard.stripe.com/test/apikeys'
    );
  }

  return new Stripe(secretKey, {
    apiVersion: '2025-10-29.clover',
    typescript: true,
    appInfo: {
      name: 'Little universe',
      version: '1.0.0',
      url: 'https://github.com/SamuelZ12/longcut',
    },
  });
}

export function getStripeClient(): Stripe {
  if (!stripeClient) {
    stripeClient = createStripeClient();
  }

  return stripeClient;
}

/**
 * Stripe Price IDs from environment variables
 * These are configured in .env.local and created in the Stripe Dashboard
 */
export const STRIPE_PRICE_IDS = {
  /** Pro subscription: $9.99/month recurring */
  PRO_SUBSCRIPTION: process.env.STRIPE_PRO_PRICE_ID!,

  /** Pro subscription: discounted annual option ($99.99/year) */
  PRO_SUBSCRIPTION_ANNUAL: process.env.STRIPE_PRO_ANNUAL_PRICE_ID!,

  /** Top-Up credits: $2.99 one-time for +20 video credits (USD) */
  TOPUP_CREDITS: process.env.STRIPE_TOPUP_PRICE_ID!,

  /** Top-Up credits: ¥20 one-time for +20 video credits (CNY) - Optional for WeChat Pay */
  TOPUP_CREDITS_CNY: process.env.STRIPE_TOPUP_PRICE_ID_CNY,
} as const;

/**
 * Validates that all required Stripe configuration is present
 * Call this during app initialization or in API routes to fail fast
 *
 * @throws Error if any required config is missing or misconfigured
 */
export function validateStripeConfig(): void {
  const missing: string[] = [];

  if (!process.env.STRIPE_SECRET_KEY) {
    missing.push('STRIPE_SECRET_KEY');
  }

  if (!process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) {
    missing.push('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY');
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    missing.push('STRIPE_WEBHOOK_SECRET');
  }

  if (!process.env.STRIPE_PRO_PRICE_ID) {
    missing.push('STRIPE_PRO_PRICE_ID');
  }

  if (!process.env.STRIPE_PRO_ANNUAL_PRICE_ID) {
    missing.push('STRIPE_PRO_ANNUAL_PRICE_ID');
  }

  if (!process.env.STRIPE_TOPUP_PRICE_ID) {
    missing.push('STRIPE_TOPUP_PRICE_ID');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required Stripe configuration: ${missing.join(', ')}\n` +
      'Please add these to your .env.local file.\n' +
      'Get your keys from: https://dashboard.stripe.com/test/apikeys\n' +
      'Get your webhook secret from: https://dashboard.stripe.com/test/webhooks'
    );
  }

  // Validate that price IDs match the Stripe key mode (test vs live)
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const isTestMode = secretKey?.startsWith('sk_test_');
  const isLiveMode = secretKey?.startsWith('sk_live_');

  if (isTestMode || isLiveMode) {
    const priceIds = {
      'STRIPE_PRO_PRICE_ID': process.env.STRIPE_PRO_PRICE_ID,
      'STRIPE_PRO_ANNUAL_PRICE_ID': process.env.STRIPE_PRO_ANNUAL_PRICE_ID,
      'STRIPE_TOPUP_PRICE_ID': process.env.STRIPE_TOPUP_PRICE_ID,
    };

    const modeMismatches: string[] = [];

    for (const [varName, priceId] of Object.entries(priceIds)) {
      if (!priceId) continue;

      // Price IDs don't have explicit test/live prefix, but we can warn about potential issues
      // Stripe will throw a proper error when trying to use them
      if (isTestMode && priceId.includes('live')) {
        modeMismatches.push(`${varName} (${priceId}) may be a live mode price but test keys are being used`);
      }
    }

    if (modeMismatches.length > 0) {
      console.warn(
        '⚠️  Potential Stripe mode mismatch detected:\n' +
        modeMismatches.map(m => `  - ${m}`).join('\n') +
        '\n' +
        'If you encounter "No such price" errors, verify that your price IDs match your Stripe key mode.\n' +
        `Current mode: ${isTestMode ? 'TEST' : 'LIVE'}`
      );
    }
  }
}
