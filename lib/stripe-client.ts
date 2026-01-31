import Stripe from 'stripe';

/**
 * Lazily instantiated Stripe client for server-side operations
 * Returns null if Stripe is not configured (payments disabled)
 */
let stripeClient: Stripe | null | undefined = undefined;

function createStripeClient(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    console.warn('[Stripe] STRIPE_SECRET_KEY not set - payment features disabled');
    return null;
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

/**
 * Get Stripe client if configured, otherwise returns null
 * Payment features will be disabled when Stripe is not configured
 */
export function getStripeClient(): Stripe | null {
  if (stripeClient === undefined) {
    stripeClient = createStripeClient();
  }

  return stripeClient;
}

/**
 * Check if Stripe is configured and available
 */
export function isStripeConfigured(): boolean {
  return getStripeClient() !== null;
}

/**
 * Stripe Price IDs from environment variables
 * These are configured in .env.local and created in the Stripe Dashboard
 */
export const STRIPE_PRICE_IDS = {
  /** Pro subscription: $9.99/month recurring */
  PRO_SUBSCRIPTION: process.env.STRIPE_PRO_PRICE_ID,

  /** Pro subscription: discounted annual option ($99.99/year) */
  PRO_SUBSCRIPTION_ANNUAL: process.env.STRIPE_PRO_ANNUAL_PRICE_ID,

  /** Top-Up credits: $2.99 one-time for +20 video credits (USD) */
  TOPUP_CREDITS: process.env.STRIPE_TOPUP_PRICE_ID,

  /** Top-Up credits: ¥20 one-time for +20 video credits (CNY) - Optional for WeChat Pay */
  TOPUP_CREDITS_CNY: process.env.STRIPE_TOPUP_PRICE_ID_CNY,
} as const;

/**
 * Validates that all required Stripe configuration is present
 * Returns validation result without throwing - Stripe is optional
 */
export function validateStripeConfig(): { configured: boolean; missing: string[] } {
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

  const configured = missing.length === 0;

  if (!configured) {
    console.warn(
      `[Stripe] Missing configuration: ${missing.join(', ')}\n` +
      'Payment features are disabled. Add these to .env.local to enable.'
    );
  }

  return { configured, missing };
}
