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

export function getProviderDefaultModel(key: ProviderKey): string {
  return PROVIDER_DEFAULT_MODELS[key];
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
