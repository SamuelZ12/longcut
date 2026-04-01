import { createGeminiAdapter } from './gemini-adapter';
import { createGrokAdapter } from './grok-adapter';
import { createMiniMaxAdapter } from './minimax-adapter';
import {
  getConfiguredProviderKey,
  getProviderFallbackOrder,
  getProviderPriorityOrder,
} from './provider-config';
import type {
  ProviderAdapter,
  ProviderGenerateParams,
  ProviderGenerateResult,
  ProviderKey,
} from './types';

type ProviderFactory = () => ProviderAdapter;

const providerFactories: Record<ProviderKey, ProviderFactory> = {
  grok: createGrokAdapter,
  gemini: createGeminiAdapter,
  minimax: createMiniMaxAdapter,
};

const providerEnvGuards: Record<ProviderKey, () => string | undefined> = {
  grok: () => process.env.XAI_API_KEY,
  gemini: () => process.env.GEMINI_API_KEY,
  minimax: () => process.env.MINIMAX_API_KEY,
};

const providerCache: Partial<Record<ProviderKey, ProviderAdapter>> = {};

function resolveProviderKey(preferred?: string): ProviderKey {
  const envPreference = getConfiguredProviderKey(preferred);

  if (envPreference) {
    return envPreference;
  }

  for (const key of getProviderPriorityOrder()) {
    if (providerEnvGuards[key]()) {
      return key;
    }
  }

  return 'grok';
}

export function getProviderKey(preferred?: string): ProviderKey {
  return resolveProviderKey(preferred);
}

function ensureProvider(key: ProviderKey): ProviderAdapter {
  if (providerCache[key]) {
    return providerCache[key]!;
  }

  const guard = providerEnvGuards[key];
  if (!guard()) {
    throw new Error(
      `AI provider "${key}" is not configured. Please supply the required environment variables.`
    );
  }

  const factory = providerFactories[key];
  const adapter = factory();
  providerCache[key] = adapter;
  return adapter;
}

export function availableProviders(): ProviderKey[] {
  return (Object.keys(providerFactories) as ProviderKey[]).filter((key) => {
    try {
      return !!providerEnvGuards[key]();
    } catch {
      return false;
    }
  });
}

export function getProvider(key?: string): ProviderAdapter {
  const resolvedKey = resolveProviderKey(key);
  console.log(`[AI Provider] Using provider: ${resolvedKey}`);
  return ensureProvider(resolvedKey);
}

function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('429') ||
    lowerMessage.includes('service unavailable') ||
    lowerMessage.includes('500') ||
    lowerMessage.includes('503') ||
    lowerMessage.includes('502') ||
    lowerMessage.includes('504') ||
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('overload')
  );
}

function getFallbackProvider(currentKey: ProviderKey): ProviderKey | null {
  const fallback = getProviderFallbackOrder(currentKey, availableProviders())[0];
  return fallback ?? null;
}

export async function generateStructuredContent(
  params: ProviderGenerateParams & { provider?: string }
): Promise<ProviderGenerateResult> {
  const { provider, ...rest } = params;
  const primaryKey = resolveProviderKey(provider);
  const primaryAdapter = getProvider(provider);

  try {
    return await primaryAdapter.generate(rest);
  } catch (error) {
    if (provider) {
      throw error;
    }

    // If the error is retryable and we have a fallback provider, try it
    if (isRetryableError(error)) {
      const fallbackKey = getFallbackProvider(primaryKey);
      if (fallbackKey) {
        console.warn(
          `[AI Provider] ${primaryKey} failed with retryable error, trying fallback: ${fallbackKey}`
        );
        try {
          const fallbackAdapter = ensureProvider(fallbackKey);
          console.log(`[AI Provider] Using fallback provider: ${fallbackKey}`);
          return await fallbackAdapter.generate(rest);
        } catch (fallbackError) {
          console.error(`[AI Provider] Fallback provider ${fallbackKey} also failed:`, fallbackError);
          // Throw the original error if fallback also fails
          throw error;
        }
      }
    }
    throw error;
  }
}
