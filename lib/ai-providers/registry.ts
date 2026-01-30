import { createGeminiAdapter } from './gemini-adapter';
import { createGrokAdapter } from './grok-adapter';
import { createDeepSeekAdapter } from './deepseek-adapter';
import type { ProviderAdapter, ProviderGenerateParams, ProviderGenerateResult } from './types';

type ProviderKey = 'grok' | 'gemini' | 'deepseek';

type ProviderFactory = () => ProviderAdapter;

const providerFactories: Record<ProviderKey, ProviderFactory> = {
  grok: createGrokAdapter,
  gemini: createGeminiAdapter,
  deepseek: createDeepSeekAdapter,
};

const providerEnvGuards: Record<ProviderKey, () => string | undefined> = {
  grok: () => process.env.XAI_API_KEY,
  gemini: () => process.env.GEMINI_API_KEY,
  deepseek: () => process.env.DEEPSEEK_API_KEY,
};

const providerCache: Partial<Record<ProviderKey, ProviderAdapter>> = {};

function resolveProviderKey(preferred?: string, cookieProvider?: string): ProviderKey {
  // Priority: cookie > preferred parameter > env > first available
  const resolvedPreference =
    cookieProvider || preferred || process.env.AI_PROVIDER || process.env.NEXT_PUBLIC_AI_PROVIDER;

  if (resolvedPreference && resolvedPreference in providerFactories) {
    return resolvedPreference as ProviderKey;
  }

  if (providerEnvGuards.grok()) {
    return 'grok';
  }
  if (providerEnvGuards.gemini()) {
    return 'gemini';
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
    lowerMessage.includes('service unavailable') ||
    lowerMessage.includes('503') ||
    lowerMessage.includes('502') ||
    lowerMessage.includes('504') ||
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('overload')
  );
}

function getFallbackProvider(currentKey: ProviderKey): ProviderKey | null {
  const available = availableProviders();
  const fallback = available.find((key) => key !== currentKey);
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

