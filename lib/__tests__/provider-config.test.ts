import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getProviderBehavior,
  getProviderDefaultModel,
  getProviderFallbackOrder,
  normalizeProviderKey,
} from '../ai-providers/provider-config';

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
