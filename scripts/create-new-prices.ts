#!/usr/bin/env tsx
/**
 * Script to create new Stripe prices for updated pricing ($9.99/month, $99.99/year, $2.99 top-up)
 *
 * This script creates the correct prices in TEST mode for local development.
 *
 * Usage:
 *   npm run stripe:create-prices
 *   or
 *   tsx scripts/create-new-prices.ts
 *
 * Prerequisites:
 * - STRIPE_SECRET_KEY must be set in .env.local (test mode key)
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
}

async function main() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    console.error('❌ Error: STRIPE_SECRET_KEY is not set');
    console.error('   Please add it to your .env.local file');
    process.exit(1);
  }

  const stripe = new Stripe(secretKey, {
    apiVersion: '2024-10-28.acacia' as any,
    typescript: true,
  });

  const isTestMode = secretKey.startsWith('sk_test_');
  console.log(`🚀 Creating new prices in ${isTestMode ? 'TEST' : 'LIVE'} mode\n`);

  // Get the Pro product
  const products = await stripe.products.list({ limit: 20 });
  const proProduct = products.data.find(p =>
    p.name.includes('Little universe Pro') ||
    p.name.includes('TLDW Pro') ||
    p.name.includes('Pro Subscription')
  );
  const topupProduct = products.data.find(p =>
    p.name.includes('Top-Up') ||
    p.name.includes('Top Up') ||
    p.name.includes('Credits') ||
    p.name.includes('Top-Up Credits')
  );

  if (!proProduct) {
    console.error('❌ Could not find Little universe Pro product');
    console.error('   Please create the product first in your Stripe dashboard');
    process.exit(1);
  }

  console.log(`📦 Found Pro product: ${proProduct.name} (${proProduct.id})`);

  // Create monthly price: $9.99/month
  console.log('\nCreating monthly price: $9.99/month...');
  const monthlyPrice = await stripe.prices.create({
    product: proProduct.id,
    unit_amount: 999, // $9.99 in cents
    currency: 'usd',
    recurring: {
      interval: 'month',
    },
    nickname: 'Pro Monthly - $9.99',
  });
  console.log(`✅ Created: ${monthlyPrice.id}`);

  // Create annual price: $99.99/year
  console.log('Creating annual price: $99.99/year...');
  const annualPrice = await stripe.prices.create({
    product: proProduct.id,
    unit_amount: 9999, // $99.99 in cents
    currency: 'usd',
    recurring: {
      interval: 'year',
    },
    nickname: 'Pro Annual - $99.99',
  });
  console.log(`✅ Created: ${annualPrice.id}`);

  // Create top-up price: $2.99 one-time
  let topupPrice: Stripe.Price | null = null;
  if (topupProduct) {
    console.log(`\n📦 Found Top-Up product: ${topupProduct.name} (${topupProduct.id})`);
    console.log('Creating top-up price: $2.99...');
    topupPrice = await stripe.prices.create({
      product: topupProduct.id,
      unit_amount: 299, // $2.99 in cents
      currency: 'usd',
      nickname: 'Top-Up Credits - $2.99',
      metadata: {
        credits: '20', // 20 video credits per top-up
      },
    });
    console.log(`✅ Created: ${topupPrice.id}`);
  } else {
    console.log('\n⚠️  Could not find Top-Up product');
    console.log('   Creating new Top-Up product...');
    const newTopupProduct = await stripe.products.create({
      name: 'Little universe Top-Up Credits',
      description: '20 additional video credits for Little universe',
    });
    console.log(`✅ Created product: ${newTopupProduct.id}`);

    console.log('Creating top-up price: $2.99...');
    topupPrice = await stripe.prices.create({
      product: newTopupProduct.id,
      unit_amount: 299, // $2.99 in cents
      currency: 'usd',
      nickname: 'Top-Up Credits - $2.99',
      metadata: {
        credits: '20', // 20 video credits per top-up
      },
    });
    console.log(`✅ Created: ${topupPrice.id}`);
  }

  console.log('\n🎉 Success! New prices created:\n');
  console.log(`Monthly Price ID:  ${monthlyPrice.id}`);
  console.log(`Annual Price ID:   ${annualPrice.id}`);
  if (topupPrice) {
    console.log(`Top-Up Price ID:   ${topupPrice.id}`);
  }

  console.log('\n📝 Next steps:');
  console.log('1. Update your .env.local with these new price IDs:');
  console.log(`   STRIPE_PRO_PRICE_ID=${monthlyPrice.id}`);
  console.log(`   STRIPE_PRO_ANNUAL_PRICE_ID=${annualPrice.id}`);
  if (topupPrice) {
    console.log(`   STRIPE_TOPUP_PRICE_ID=${topupPrice.id}`);
  }

  if (!isTestMode) {
    console.log('\n2. Update your Vercel environment variables:');
    console.log('   Go to: https://vercel.com/samuelz12s-projects/tldw/settings/environment-variables');
    console.log(`   Set STRIPE_PRO_PRICE_ID to: ${monthlyPrice.id}`);
    console.log(`   Set STRIPE_PRO_ANNUAL_PRICE_ID to: ${annualPrice.id}`);
    if (topupPrice) {
      console.log(`   Set STRIPE_TOPUP_PRICE_ID to: ${topupPrice.id}`);
    }
  }
}

main().catch(error => {
  console.error('💥 Error:', error);
  process.exit(1);
});
