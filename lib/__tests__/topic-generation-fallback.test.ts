import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderKey } from '../ai-providers';

import {
  buildFallbackTopicTitle,
  getProviderBackedTopicModel,
  retryProviderBackedTopicGeneration,
} from '../ai-processing';
import { generateStructuredContent } from '../ai-providers';

function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>
) {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return run().finally(() => {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function withMockFetch<T>(mockFetch: typeof fetch, run: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function createTranscript(durationSeconds: number) {
  return [
    {
      start: 0,
      duration: durationSeconds,
      text: 'A short transcript segment for testing.',
    },
  ];
}

test('retryProviderBackedTopicGeneration tries another configured provider before giving up', async () => {
  const attemptedProviders: string[] = [];

  const result = await retryProviderBackedTopicGeneration({
    primaryProvider: 'minimax',
    availableProviderKeys: ['minimax', 'grok'],
    run: async (provider) => {
      attemptedProviders.push(provider);

      if (provider === 'minimax') {
        return [];
      }

      return ['usable-topic'];
    },
    isUsableResult: (value) => Array.isArray(value) && value.length > 0,
  });

  assert.deepEqual(attemptedProviders, ['minimax', 'grok']);
  assert.equal(result.providerUsed, 'grok');
  assert.deepEqual(result.result, ['usable-topic']);
});

test('retryProviderBackedTopicGeneration keeps the primary provider when it succeeds', async () => {
  const attemptedProviders: string[] = [];

  const result = await retryProviderBackedTopicGeneration({
    primaryProvider: 'minimax',
    availableProviderKeys: ['minimax', 'grok'],
    run: async (provider) => {
      attemptedProviders.push(provider);
      return ['usable-topic'];
    },
    isUsableResult: (value) => Array.isArray(value) && value.length > 0,
  });

  assert.deepEqual(attemptedProviders, ['minimax']);
  assert.equal(result.providerUsed, 'minimax');
  assert.deepEqual(result.result, ['usable-topic']);
});

test('buildFallbackTopicTitle(0, 270) returns Highlights from 00:00-04:30', () => {
  assert.equal(
    buildFallbackTopicTitle(0, 270),
    'Highlights from 00:00-04:30'
  );
});

test('generateStructuredContent keeps explicit provider attempts on one provider', async () => {
  const requestedUrls: string[] = [];

  await withEnv(
    {
      MINIMAX_API_KEY: 'test-minimax-key',
      XAI_API_KEY: 'test-grok-key',
      GEMINI_API_KEY: undefined,
    },
    async () => {
      await withMockFetch(
        async (input) => {
          requestedUrls.push(String(input));

          return new Response(
            JSON.stringify({
              base_resp: {
                status_code: 1002,
                status_msg: 'rate limited',
              },
            }),
            { status: 429, statusText: 'Too Many Requests' }
          );
        },
        async () => {
          await assert.rejects(
            () =>
              generateStructuredContent({
                provider: 'minimax',
                prompt: 'Return JSON only',
              }),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.match(error.message, /MiniMax API rate limit/i);
              return true;
            }
          );
        }
      );
    }
  );

  assert.equal(requestedUrls.length, 1);
  assert.match(requestedUrls[0], /minimax/i);
});

test('getProviderBackedTopicModel uses the fast model for short smart-video retries', () => {
  assert.equal(
    getProviderBackedTopicModel({
      provider: 'grok' satisfies ProviderKey,
      mode: 'smart',
      transcript: createTranscript(30),
    }),
    'grok-4-1-fast-non-reasoning'
  );
});
