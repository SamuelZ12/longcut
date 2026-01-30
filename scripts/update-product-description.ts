#!/usr/bin/env tsx
/**
 * Update Stripe Product Description Script
 *
 * This script updates the Little universe Pro product description to show the correct
 * video limit (100 videos per month instead of 40).
 *
 * Usage:
 *   tsx scripts/update-product-description.ts
 *
 * Prerequisites:
 * - STRIPE_SECRET_KEY must be set in .env.local
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
 * Find the Little universe Pro product
 */
async function findLittle universeProProduct(stripe: Stripe): Promise<Stripe.Product | null> {
  try {
    const products = await stripe.products.list({ limit: 100 });
    const proProduct = products.data.find(
      p => p.name.includes('Little universe Pro') || p.name.includes('Pro')
    );
    return proProduct || null;
  } catch (error) {
    console.error('❌ Error fetching products:', error);
    return null;
  }
}

/**
 * Update product description
 */
async function updateProductDescription(
  stripe: Stripe,
  productId: string,
  oldDescription: string
): Promise<void> {
  // Replace 40 with 100 in the description
  const newDescription = oldDescription.replace(
    /(\d+)\s+videos?\s+per\s+month/i,
    '100 videos per month'
  );

  if (oldDescription === newDescription) {
    console.log('⚠️  Description already appears to be correct or does not match expected pattern');
    console.log(`   Current: ${oldDescription}\n`);
    return;
  }

  console.log('📝 Updating product description...');
  console.log(`   Old: ${oldDescription}`);
  console.log(`   New: ${newDescription}\n`);

  try {
    await stripe.products.update(productId, {
      description: newDescription,
    });

    console.log('✅ Product description updated successfully!\n');
  } catch (error) {
    if (error instanceof Error) {
      console.error('❌ Error updating product:', error.message);
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
  console.log('🚀 Update Stripe Product Description\n');
  console.log('This script will update the Little universe Pro product description.\n');

  // Initialize Stripe
  const stripe = initializeStripe();

  const isTestMode = process.env.STRIPE_SECRET_KEY?.includes('_test_');
  console.log(`ℹ️  Mode: ${isTestMode ? 'TEST' : 'LIVE'}\n`);

  // Find the Little universe Pro product
  console.log('🔍 Searching for Little universe Pro product...\n');
  const product = await findLittle universeProProduct(stripe);

  if (!product) {
    console.error('❌ Error: Could not find Little universe Pro product');
    console.error('   Please check your Stripe dashboard to verify the product exists\n');
    process.exit(1);
  }

  console.log('✅ Found product:');
  console.log(`   ID: ${product.id}`);
  console.log(`   Name: ${product.name}`);
  console.log(`   Description: ${product.description || '(none)'}\n`);

  if (!product.description) {
    console.error('❌ Error: Product has no description to update\n');
    process.exit(1);
  }

  // Update the description
  await updateProductDescription(stripe, product.id, product.description);

  console.log('🎉 Update complete!\n');
  console.log('📚 Next steps:');
  console.log('   1. Verify the change in your Stripe Dashboard');

  const dashboardUrl = isTestMode
    ? `https://dashboard.stripe.com/test/products/${product.id}`
    : `https://dashboard.stripe.com/products/${product.id}`;

  console.log(`      ${dashboardUrl}`);
  console.log('   2. Test the subscription update flow to see the new description\n');
  console.log('✨ Done!\n');
}

// Run the script
main().catch((error) => {
  console.error('💥 Unexpected error during update:', error);
  process.exit(1);
});
