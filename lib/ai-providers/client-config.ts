import { normalizeProviderKey } from './provider-config';
import type { ProviderKey } from './types';

type ClientProviderKey = ProviderKey;

function resolveClientProviderKey(): ClientProviderKey {
  return normalizeProviderKey(process.env.NEXT_PUBLIC_AI_PROVIDER) ?? 'grok';
}

export function getClientProviderKey(): ClientProviderKey {
  return resolveClientProviderKey();
}

export function isGrokProviderOnClient(): boolean {
  return resolveClientProviderKey() === 'grok';
}
