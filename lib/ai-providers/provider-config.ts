import type { ProviderBehavior, ProviderKey } from './types';

const PROVIDER_ORDER: ProviderKey[] = ['grok', 'gemini', 'minimax'];

const PROVIDER_DEFAULT_MODELS: Record<ProviderKey, string> = {
  grok: 'grok-4-1-fast-non-reasoning',
  gemini: 'gemini-2.5-flash-lite',
  minimax: 'MiniMax-M2.7',
};

const PROVIDER_BEHAVIORS: Record<ProviderKey, ProviderBehavior> = {
  grok: {
    forceFullTranscriptTopicGeneration: true,
  },
  gemini: {
    forceFullTranscriptTopicGeneration: false,
  },
  minimax: {
    forceFullTranscriptTopicGeneration: false,
  },
};

const PROVIDER_ENV_KEYS: Record<ProviderKey, string> = {
  grok: 'XAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
};

export function normalizeProviderKey(value?: string | null): ProviderKey | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (normalized === 'grok' || normalized === 'gemini' || normalized === 'minimax') {
    return normalized;
  }

  return undefined;
}

export function getConfiguredProviderKey(preferred?: string): ProviderKey | undefined {
  return normalizeProviderKey(
    preferred ?? process.env.AI_PROVIDER ?? process.env.NEXT_PUBLIC_AI_PROVIDER
  );
}

export function getEffectiveProviderKey(preferred?: string): ProviderKey {
  const configuredProvider = getConfiguredProviderKey(preferred);

  if (configuredProvider) {
    return configuredProvider;
  }

  for (const key of PROVIDER_ORDER) {
    if (process.env[PROVIDER_ENV_KEYS[key]]) {
      return key;
    }
  }

  return 'grok';
}

export function getProviderDefaultModel(key: ProviderKey): string {
  return PROVIDER_DEFAULT_MODELS[key];
}

export function getProviderModelDefaults(preferred?: string): {
  defaultModel: string;
  fastModel: string;
  proModel: string;
} {
  const providerKey = getEffectiveProviderKey(preferred);
  const defaultModel =
    process.env.AI_DEFAULT_MODEL ?? getProviderDefaultModel(providerKey);
  const fastModel = process.env.AI_FAST_MODEL ?? defaultModel;
  const proModel = process.env.AI_PRO_MODEL ?? fastModel;

  return {
    defaultModel,
    fastModel,
    proModel,
  };
}

export function getProviderBehavior(key: ProviderKey): ProviderBehavior {
  return PROVIDER_BEHAVIORS[key];
}

export function getProviderPriorityOrder(): ProviderKey[] {
  return [...PROVIDER_ORDER];
}

export function getProviderFallbackOrder(
  currentKey?: ProviderKey,
  availableKeys?: ProviderKey[]
): ProviderKey[] {
  const available = availableKeys ? new Set(availableKeys) : undefined;

  return PROVIDER_ORDER.filter((key) => {
    if (key === currentKey) {
      return false;
    }

    return available ? available.has(key) : true;
  });
}
