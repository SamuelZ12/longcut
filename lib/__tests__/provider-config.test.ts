import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getEffectiveProviderKey,
  getProviderModelDefaults,
  getProviderBehavior,
  getProviderDefaultModel,
  getProviderFallbackOrder,
  normalizeProviderKey,
} from '../ai-providers/provider-config';

function withEnv<T>(values: Record<string, string | undefined>, run: () => T) {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('provider-key normalization accepts MiniMax', () => {
  assert.equal(normalizeProviderKey('MiniMax'), 'minimax');
});

test('provider behavior forceFullTranscriptTopicGeneration is enabled only for Grok', () => {
  assert.equal(
    getProviderBehavior('grok').forceFullTranscriptTopicGeneration,
    true
  );
  assert.equal(
    getProviderBehavior('gemini').forceFullTranscriptTopicGeneration,
    false
  );
  assert.equal(
    getProviderBehavior('minimax').forceFullTranscriptTopicGeneration,
    false
  );
});

test('deterministic fallback order prefers Grok before Gemini before MiniMax', () => {
  assert.deepEqual(getProviderFallbackOrder('minimax'), ['grok', 'gemini']);
  assert.deepEqual(getProviderFallbackOrder('gemini'), ['grok', 'minimax']);
  assert.deepEqual(getProviderFallbackOrder('grok'), ['gemini', 'minimax']);
});

test('provider default model returns MiniMax-M2.7 for MiniMax', () => {
  assert.equal(getProviderDefaultModel('minimax'), 'MiniMax-M2.7');
});

test('provider model defaults derive fast and pro topic models from configured MiniMax provider', () => {
  withEnv(
    {
      AI_PROVIDER: 'minimax',
      NEXT_PUBLIC_AI_PROVIDER: undefined,
      AI_DEFAULT_MODEL: undefined,
      AI_FAST_MODEL: undefined,
      AI_PRO_MODEL: undefined,
    },
    () => {
      assert.deepEqual(getProviderModelDefaults(), {
        defaultModel: 'MiniMax-M2.7',
        fastModel: 'MiniMax-M2.7',
        proModel: 'MiniMax-M2.7',
      });
    }
  );
});

test('effective provider resolves to MiniMax when only MINIMAX_API_KEY is present', () => {
  withEnv(
    {
      AI_PROVIDER: undefined,
      NEXT_PUBLIC_AI_PROVIDER: undefined,
      XAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      MINIMAX_API_KEY: 'test-minimax-key',
      AI_DEFAULT_MODEL: undefined,
      AI_FAST_MODEL: undefined,
      AI_PRO_MODEL: undefined,
    },
    () => {
      assert.equal(getEffectiveProviderKey(), 'minimax');
      assert.deepEqual(getProviderModelDefaults(), {
        defaultModel: 'MiniMax-M2.7',
        fastModel: 'MiniMax-M2.7',
        proModel: 'MiniMax-M2.7',
      });
    }
  );
});
