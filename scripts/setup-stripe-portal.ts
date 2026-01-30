#!/usr/bin/env tsx
/**
 * Stripe Customer Portal Setup Script
 *
 * This script creates or updates the Stripe Customer Portal configuration,
 * which is required before customers can access the billing portal.
 *
 * The Customer Portal allows customers to:
 * - Update payment methods
 * - View invoices
 * - Cancel subscriptions
 * - View subscription history
 *
 * Usage:
 *   npm run stripe:setup-portal
 *   or
 *   tsx scripts/setup-stripe-portal.ts
 *
 * Prerequisites:
 * - STRIPE_SECRET_KEY must be set in .env.local
 * - NEXT_PUBLIC_APP_URL should be set (recommended)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import Stripe from 'stripe';

// Load .env.local file manually
try {
  const envPath = resolve(process.cwd(), '.env.local');
  const envFile = readFileSync(envPath, 'utf-8');
  envFile.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=');
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  });
} catch {
  console.error('⚠️  Warning: Could not load .env.local file');
  console.error('   Make sure environment variables are set via system or .env.local\n');
}

/**
 * Initialize Stripe client
 */
function initializeStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    console.error('❌ Error: STRIPE_SECRET_KEY is not set');
    console.error('   Please add it to your .env.local file');
    console.error('   Get your key from: https://dashboard.stripe.com/test/apikeys\n');
    process.exit(1);
  }

  if (!secretKey.startsWith('sk_')) {
    console.error('❌ Error: STRIPE_SECRET_KEY must start with "sk_"');
    console.error('   Current value does not appear to be a valid Stripe secret key\n');
    process.exit(1);
  }

  return new Stripe(secretKey, {
    apiVersion: '2024-10-28.acacia' as any,
    typescript: true,
    appInfo: {
      name: 'Little universe',
      version: '1.0.0',
    },
  });
}

/**
 * Check if a portal configuration already exists
 */
async function getExistingConfiguration(stripe: Stripe): Promise<Stripe.BillingPortal.Configuration | null> {
  try {
    const configurations = await stripe.billingPortal.configurations.list({ limit: 1 });
    return configurations.data.length > 0 ? configurations.data[0] : null;
  } catch (error) {
    console.error('❌ Error fetching existing configurations:', error);
    return null;
  }
}

/**
 * Get the product ID from a price
 */
async function getProductFromPrice(stripe: Stripe, priceId: string): Promise<string | null> {
  try {
    const price = await stripe.prices.retrieve(priceId);
    return typeof price.product === 'string' ? price.product : price.product.id;
  } catch (error) {
    console.error(`❌ Error fetching price ${priceId}:`, error);
    return null;
  }
}

/**
 * Create a new billing portal configuration
 */
async function createPortalConfiguration(stripe: Stripe): Promise<void> {
  const isTestMode = process.env.STRIPE_SECRET_KEY?.includes('_test_');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  console.log(`📋 Creating Customer Portal configuration...`);
  console.log(`   Mode: ${isTestMode ? 'TEST' : 'LIVE'}`);
  console.log(`   Return URL: ${appUrl}/settings\n`);

  // Get price IDs from environment
  const monthlyPriceId = process.env.STRIPE_PRO_PRICE_ID;
  const annualPriceId = process.env.STRIPE_PRO_ANNUAL_PRICE_ID;

  // Fetch product ID from the monthly price
  let productId: string | null = null;
  let subscriptionUpdateConfig: any = undefined;

  if (monthlyPriceId && annualPriceId) {
    console.log('🔍 Fetching product information for subscription updates...\n');
    productId = await getProductFromPrice(stripe, monthlyPriceId);

    if (productId) {
      subscriptionUpdateConfig = {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'always_invoice',
        products: [
          {
            product: productId,
            prices: [monthlyPriceId, annualPriceId],
          },
        ],
      };
      console.log(`✅ Product found: ${productId}`);
      console.log(`   Monthly price: ${monthlyPriceId}`);
      console.log(`   Annual price: ${annualPriceId}\n`);
    } else {
      console.log('⚠️  Could not fetch product ID, subscription updates will be disabled\n');
    }
  } else {
    console.log('⚠️  Price IDs not configured, subscription updates will be disabled\n');
  }

  try {
    const configuration = await stripe.billingPortal.configurations.create({
      business_profile: {
        headline: 'Manage your Little universe subscription',
        privacy_policy_url: `${appUrl}/privacy`,
        terms_of_service_url: `${appUrl}/terms`,
      },
      features: {
        customer_update: {
          enabled: true,
          allowed_updates: ['email', 'address'],
        },
        invoice_history: {
          enabled: true,
        },
        payment_method_update: {
          enabled: true,
        },
        subscription_cancel: {
          enabled: true,
          mode: 'at_period_end',
          cancellation_reason: {
            enabled: true,
            options: [
              'too_expensive',
              'missing_features',
              'switched_service',
              'unused',
              'customer_service',
              'too_complex',
              'low_quality',
              'other',
            ],
          },
        },
        ...(subscriptionUpdateConfig && {
          subscription_update: subscriptionUpdateConfig,
        }),
      },
      default_return_url: `${appUrl}/settings`,
    });

    console.log('✅ Customer Portal configuration created successfully!');
    console.log(`   Configuration ID: ${configuration.id}`);
    console.log(`   Application: ${configuration.application || 'default'}`);
    console.log(`   Active: ${configuration.is_default ? 'Yes (default)' : 'Yes'}\n`);

    console.log('📝 Enabled features:');
    console.log('   • Update email and address');
    console.log('   • View invoice history');
    console.log('   • Update payment methods');
    console.log('   • Cancel subscriptions (at period end)');
    if (subscriptionUpdateConfig) {
      console.log('   • Switch between monthly and annual plans');
    }
    console.log('');
  } catch (error) {
    if (error instanceof Error) {
      console.error('❌ Error creating portal configuration:', error.message);

      if ('type' in error && error.type === 'StripeInvalidRequestError') {
        console.error('\n💡 Troubleshooting tips:');
        console.error('   • Make sure your Stripe account is fully activated');
        console.error('   • Verify you have the correct API key');
        console.error('   • Check that privacy_policy_url and terms_of_service_url are valid URLs');
      }
    } else {
      console.error('❌ Unexpected error:', error);
    }
    process.exit(1);
  }
}

/**
 * Update an existing billing portal configuration
 */
async function updatePortalConfiguration(
  stripe: Stripe,
  configId: string
): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  console.log(`📋 Updating existing Customer Portal configuration...`);
  console.log(`   Configuration ID: ${configId}\n`);

  // Get price IDs from environment
  const monthlyPriceId = process.env.STRIPE_PRO_PRICE_ID;
  const annualPriceId = process.env.STRIPE_PRO_ANNUAL_PRICE_ID;

  // Fetch product ID from the monthly price
  let productId: string | null = null;
  let subscriptionUpdateConfig: any = undefined;

  if (monthlyPriceId && annualPriceId) {
    console.log('🔍 Fetching product information for subscription updates...\n');
    productId = await getProductFromPrice(stripe, monthlyPriceId);

    if (productId) {
      subscriptionUpdateConfig = {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'always_invoice',
        products: [
          {
            product: productId,
            prices: [monthlyPriceId, annualPriceId],
          },
        ],
      };
      console.log(`✅ Product found: ${productId}`);
      console.log(`   Monthly price: ${monthlyPriceId}`);
      console.log(`   Annual price: ${annualPriceId}\n`);
    } else {
      console.log('⚠️  Could not fetch product ID, subscription updates will be disabled\n');
    }
  } else {
    console.log('⚠️  Price IDs not configured, subscription updates will be disabled\n');
  }

  try {
    const configuration = await stripe.billingPortal.configurations.update(configId, {
      business_profile: {
        headline: 'Manage your Little universe subscription',
        privacy_policy_url: `${appUrl}/privacy`,
        terms_of_service_url: `${appUrl}/terms`,
      },
      features: {
        customer_update: {
          enabled: true,
          allowed_updates: ['email', 'address'],
        },
        invoice_history: {
          enabled: true,
        },
        payment_method_update: {
          enabled: true,
        },
        subscription_cancel: {
          enabled: true,
          mode: 'at_period_end',
        },
        ...(subscriptionUpdateConfig && {
          subscription_update: subscriptionUpdateConfig,
        }),
      },
    });

    console.log('✅ Customer Portal configuration updated successfully!');
    console.log(`   Configuration ID: ${configuration.id}`);
    console.log(`   Active: ${configuration.is_default ? 'Yes (default)' : 'Yes'}\n`);

    console.log('📝 Enabled features:');
    console.log('   • Update email and address');
    console.log('   • View invoice history');
    console.log('   • Update payment methods');
    console.log('   • Cancel subscriptions (at period end)');
    if (subscriptionUpdateConfig) {
      console.log('   • Switch between monthly and annual plans');
    }
    console.log('');
  } catch (error) {
    if (error instanceof Error) {
      console.error('❌ Error updating portal configuration:', error.message);
    } else {
      console.error('❌ Unexpected error:', error);
    }
    process.exit(1);
  }
}

/**
 * Main execution function
 */
async function main() {
  console.log('🚀 Stripe Customer Portal Setup\n');
  console.log('This script will configure the Stripe Customer Portal for your application.\n');

  // Initialize Stripe
  const stripe = initializeStripe();

  // Check for existing configuration
  const existingConfig = await getExistingConfiguration(stripe);

  if (existingConfig) {
    console.log('ℹ️  Found existing portal configuration');
    console.log(`   ID: ${existingConfig.id}`);
    console.log(`   Created: ${new Date((existingConfig as any).created * 1000).toLocaleDateString()}\n`);

    // Ask user if they want to update (in a real scenario, you might want to prompt)
    // For now, we'll just update it
    await updatePortalConfiguration(stripe, existingConfig.id);
  } else {
    console.log('ℹ️  No existing portal configuration found\n');
    await createPortalConfiguration(stripe);
  }

  console.log('🎉 Setup complete!\n');
  console.log('📚 Next steps:');
  console.log('   1. Test the portal by clicking "Manage billing" in your app settings');
  console.log('   2. Customize the portal further in the Stripe Dashboard:');

  const isTestMode = process.env.STRIPE_SECRET_KEY?.includes('_test_');
  const dashboardUrl = isTestMode
    ? 'https://dashboard.stripe.com/test/settings/billing/portal'
    : 'https://dashboard.stripe.com/settings/billing/portal';

  console.log(`      ${dashboardUrl}\n`);
  console.log('✨ Done!\n');
}

// Run the script
main().catch((error) => {
  console.error('💥 Unexpected error during setup:', error);
  process.exit(1);
});
