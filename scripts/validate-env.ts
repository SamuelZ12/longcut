#!/usr/bin/env tsx
/**
 * Environment Variable Validation Script
 *
 * Run this script before starting the application to ensure all required
 * environment variables are configured correctly.
 *
 * Usage:
 *   npm run validate-env
 *   or
 *   tsx scripts/validate-env.ts
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
  // .env.local doesn't exist, which is okay - might be using system env vars
}

// Note: We don't import stripe-client here to avoid initialization errors
// when env vars are missing. Instead, we validate the raw environment.

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function validateRequiredEnvVars(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required environment variables
  const required = {
    // Supabase
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,

    // Stripe (validated separately)
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRO_PRICE_ID: process.env.STRIPE_PRO_PRICE_ID,
    STRIPE_TOPUP_PRICE_ID: process.env.STRIPE_TOPUP_PRICE_ID,
  };

  // Check each required variable
  for (const [key, value] of Object.entries(required)) {
    if (!value || value.trim() === '') {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  const recommended = {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    AI_PROVIDER: process.env.AI_PROVIDER ?? process.env.NEXT_PUBLIC_AI_PROVIDER,
    AI_DEFAULT_MODEL: process.env.AI_DEFAULT_MODEL ?? process.env.NEXT_PUBLIC_AI_MODEL,
  };

  for (const [key, value] of Object.entries(recommended)) {
    if (!value || value.trim() === '') {
      warnings.push(`Missing recommended environment variable: ${key}`);
    }
  }

  const preferredProvider =
    process.env.AI_PROVIDER ?? process.env.NEXT_PUBLIC_AI_PROVIDER ?? 'grok';
  const hasMiniMaxKey = !!process.env.MINIMAX_API_KEY?.trim();
  const hasGrokKey = !!process.env.XAI_API_KEY?.trim();
  const hasGeminiKey = !!process.env.GEMINI_API_KEY?.trim();

  if (!hasMiniMaxKey && !hasGrokKey && !hasGeminiKey) {
    errors.push(
      'Missing AI provider key: set MINIMAX_API_KEY for MiniMax, XAI_API_KEY for Grok, or GEMINI_API_KEY for Gemini.'
    );
  }

  if (preferredProvider === 'minimax' && !hasMiniMaxKey) {
    errors.push(
      'AI_PROVIDER is set to "minimax" but MINIMAX_API_KEY is missing.'
    );
  }

  if (preferredProvider === 'grok' && !hasGrokKey) {
    errors.push(
      'AI_PROVIDER is set to "grok" but XAI_API_KEY is missing.'
    );
  }

  if (preferredProvider === 'gemini' && !hasGeminiKey) {
    errors.push(
      'AI_PROVIDER is set to "gemini" but GEMINI_API_KEY is missing.'
    );
  }

  // Validate Stripe key formats
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.startsWith('sk_')) {
    errors.push('STRIPE_SECRET_KEY must start with "sk_"');
  }

  if (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY &&
      !process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.startsWith('pk_')) {
    errors.push('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must start with "pk_"');
  }

  if (process.env.STRIPE_WEBHOOK_SECRET &&
      !process.env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
    errors.push('STRIPE_WEBHOOK_SECRET must start with "whsec_"');
  }

  if (process.env.STRIPE_PRO_PRICE_ID &&
      !process.env.STRIPE_PRO_PRICE_ID.startsWith('price_')) {
    errors.push('STRIPE_PRO_PRICE_ID must start with "price_"');
  }

  if (process.env.STRIPE_TOPUP_PRICE_ID &&
      !process.env.STRIPE_TOPUP_PRICE_ID.startsWith('price_')) {
    errors.push('STRIPE_TOPUP_PRICE_ID must start with "price_"');
  }

  // Check for test vs production key consistency
  const isTestMode = process.env.STRIPE_SECRET_KEY?.includes('_test_');
  const pubKeyIsTest = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.includes('_test_');

  if (isTestMode !== pubKeyIsTest) {
    warnings.push(
      'Stripe key mismatch: Secret key and publishable key are from different modes (test/live)'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

async function validateStripePortalConfiguration(): Promise<{
  configured: boolean;
  warning?: string;
}> {
  // Skip if Stripe is not configured
  if (!process.env.STRIPE_SECRET_KEY) {
    return { configured: false };
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-10-28.acacia' as any,
      typescript: true,
    });

    // Try to list portal configurations
    const configurations = await stripe.billingPortal.configurations.list({ limit: 1 });

    if (configurations.data.length === 0) {
      return {
        configured: false,
        warning: 'Stripe Customer Portal is not configured. Run: npm run stripe:setup-portal',
      };
    }

    // Portal is configured
    return { configured: true };
  } catch {
    // If we get an error, treat as not configured but don't fail validation
    return {
      configured: false,
      warning: 'Could not verify Stripe Customer Portal configuration',
    };
  }
}

async function main() {
  console.log('🔍 Validating environment configuration...\n');

  // Validate general environment variables
  const result = validateRequiredEnvVars();

  // Display results
  if (result.errors.length > 0) {
    console.log('\n❌ Validation Failed:\n');
    result.errors.forEach((error) => {
      console.log(`  • ${error}`);
    });
  } else {
    console.log('\n✅ All required environment variables are configured correctly');
  }

  if (result.warnings.length > 0) {
    console.log('\n⚠️  Warnings:\n');
    result.warnings.forEach((warning) => {
      console.log(`  • ${warning}`);
    });
  }

  // Validate Stripe portal configuration (only if basic env vars are valid)
  if (result.valid && process.env.STRIPE_SECRET_KEY) {
    console.log('\n🔍 Validating Stripe Customer Portal...');
    const portalResult = await validateStripePortalConfiguration();

    if (portalResult.configured) {
      console.log('✅ Stripe Customer Portal is configured');
    } else if (portalResult.warning) {
      console.log(`⚠️  ${portalResult.warning}`);
    }
  }

  // Environment info (only if validation passed)
  if (result.valid) {
    console.log('\n📊 Environment Summary:');
    console.log(`  • Node Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`  • Stripe Mode: ${process.env.STRIPE_SECRET_KEY?.includes('_test_') ? 'TEST' : 'LIVE'}`);
    console.log(`  • Supabase Project: ${process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/https:\/\/([^.]+)/)?.[1] || 'unknown'}`);
  }

  // Exit with appropriate code
  if (!result.valid) {
    console.log('\n💡 Tip: Copy .env.example to .env.local and fill in the required values');
    console.log('   See docs/STRIPE_PRICE_SETUP.md for Stripe configuration instructions\n');
    process.exit(1);
  }

  console.log('\n✨ Environment validation passed!\n');
  process.exit(0);
}

main().catch((error) => {
  console.error('Unexpected error during validation:', error);
  process.exit(1);
});
