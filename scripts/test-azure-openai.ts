#!/usr/bin/env tsx
/**
 * Test script for Azure OpenAI Adapter
 *
 * Run with: npx tsx scripts/test-azure-openai.ts
 *
 * Required environment variables:
 *   AZURE_OPENAI_API_KEY
 *   AZURE_OPENAI_ENDPOINT
 *   AZURE_OPENAI_DEPLOYMENT
 *   AZURE_OPENAI_API_VERSION (optional, defaults to 2024-02-15-preview)
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { z } from 'zod';

// Load environment variables from .env.local
config({ path: resolve(process.cwd(), '.env.local') });

// Import the adapter after loading env vars
import { createAzureOpenAIAdapter } from '../lib/ai-providers/openai-adapter';

async function runTests() {
  console.log('🧪 Testing Azure OpenAI Adapter\n');
  console.log('=' .repeat(50));

  // Check environment variables
  const requiredVars = [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT'
  ];

  const missingVars = requiredVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error('\nMake sure these are set in your .env.local file');
    process.exit(1);
  }

  console.log('📋 Configuration:');
  console.log(`   Endpoint: ${process.env.AZURE_OPENAI_ENDPOINT}`);
  console.log(`   Deployment: ${process.env.AZURE_OPENAI_DEPLOYMENT}`);
  console.log(`   API Version: ${process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview'}`);
  console.log('');

  let adapter;
  try {
    adapter = createAzureOpenAIAdapter();
    console.log('✅ Adapter created successfully\n');
  } catch (error) {
    console.error('❌ Failed to create adapter:', error);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  // Test 1: Simple text generation
  console.log('=' .repeat(50));
  console.log('Test 1: Simple text generation (no schema)');
  console.log('=' .repeat(50));
  try {
    const result = await adapter.generate({
      prompt: 'Say "Hello, Azure OpenAI is working!" and nothing else.',
      maxOutputTokens: 50
    });
    console.log('✅ PASSED');
    console.log(`   Response: ${result.content.substring(0, 100)}${result.content.length > 100 ? '...' : ''}`);
    console.log(`   Model: ${result.model}`);
    console.log(`   Latency: ${result.usage?.latencyMs}ms`);
    passed++;
  } catch (error) {
    console.log('❌ FAILED');
    console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
  console.log('');

  // Test 2: Object schema (should work directly)
  console.log('=' .repeat(50));
  console.log('Test 2: Structured output with object schema');
  console.log('=' .repeat(50));
  try {
    const personSchema = z.object({
      name: z.string(),
      age: z.number(),
      city: z.string()
    });

    const result = await adapter.generate({
      prompt: 'Generate a fictional person with name, age, and city. Return valid JSON.',
      zodSchema: personSchema,
      schemaName: 'Person',
      maxOutputTokens: 100
    });

    const parsed = JSON.parse(result.content);
    console.log('✅ PASSED');
    console.log(`   Response: ${JSON.stringify(parsed)}`);
    console.log(`   Validated: name=${parsed.name}, age=${parsed.age}, city=${parsed.city}`);
    passed++;
  } catch (error) {
    console.log('❌ FAILED');
    console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
  console.log('');

  // Test 3: Array schema (tests the wrapping fix)
  console.log('=' .repeat(50));
  console.log('Test 3: Structured output with ARRAY schema (tests wrapping fix)');
  console.log('=' .repeat(50));
  try {
    const colorsSchema = z.array(z.string());

    const result = await adapter.generate({
      prompt: 'List exactly 3 colors as a JSON array of strings. Example: ["red", "blue", "green"]',
      zodSchema: colorsSchema,
      schemaName: 'Colors',
      maxOutputTokens: 50
    });

    const parsed = JSON.parse(result.content);
    console.log('✅ PASSED');
    console.log(`   Response: ${JSON.stringify(parsed)}`);
    console.log(`   Is Array: ${Array.isArray(parsed)}`);
    console.log(`   Length: ${parsed.length}`);
    passed++;
  } catch (error) {
    console.log('❌ FAILED');
    console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
  console.log('');

  // Test 4: Complex array schema (similar to summaryTakeawaysSchema)
  console.log('=' .repeat(50));
  console.log('Test 4: Complex array schema (like summaryTakeawaysSchema)');
  console.log('=' .repeat(50));
  try {
    const takeawaySchema = z.array(
      z.object({
        label: z.string(),
        insight: z.string()
      })
    );

    const result = await adapter.generate({
      prompt: 'Generate 2 takeaways about learning programming. Each should have a "label" (short title) and "insight" (explanation). Return as JSON array.',
      zodSchema: takeawaySchema,
      schemaName: 'Takeaways',
      maxOutputTokens: 300
    });

    const parsed = JSON.parse(result.content);
    console.log('✅ PASSED');
    console.log(`   Response: ${JSON.stringify(parsed).substring(0, 200)}...`);
    console.log(`   Is Array: ${Array.isArray(parsed)}`);
    console.log(`   Items: ${parsed.length}`);
    if (parsed[0]) {
      console.log(`   First item keys: ${Object.keys(parsed[0]).join(', ')}`);
    }
    passed++;
  } catch (error) {
    console.log('❌ FAILED');
    console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
  console.log('');

  // Summary
  console.log('=' .repeat(50));
  console.log('📊 Test Summary');
  console.log('=' .repeat(50));
  console.log(`   Passed: ${passed}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Total:  ${passed + failed}`);
  console.log('');

  if (failed === 0) {
    console.log('🎉 All tests passed! Azure OpenAI adapter is working correctly.');
  } else {
    console.log('⚠️  Some tests failed. Check the errors above.');
    process.exit(1);
  }
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
