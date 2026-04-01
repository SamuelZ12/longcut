import type { ZodTypeAny } from 'zod';

export type ProviderKey = 'grok' | 'gemini' | 'minimax';

export interface ProviderBehavior {
  forceFullTranscriptTopicGeneration: boolean;
  forceSmartModeOnClient: boolean;
}

export interface ProviderGenerateParams {
  prompt: string;
  model?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  zodSchema?: ZodTypeAny;
  schemaName?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderGenerateResult {
  content: string;
  rawResponse?: unknown;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    latencyMs?: number;
  };
  provider?: string;
  model?: string;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly defaultModel: string;
  generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult>;
}
