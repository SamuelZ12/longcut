import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFallbackTopicTitle,
  retryProviderBackedTopicGeneration,
} from '../ai-processing';

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
