import { z } from 'zod';
import type { ProviderAdapter, ProviderGenerateParams, ProviderGenerateResult } from './types';

const DEFAULT_MODEL = 'grok-4-1-fast-non-reasoning';
const PROVIDER_NAME = 'grok';

function ensureSchemaName(name?: string) {
  if (name && name.trim().length > 0) {
    return name.trim();
  }
  return 'ResponseSchema';
}

function buildAbortController(timeoutMs?: number) {
  if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === 'undefined') {
    return { controller: undefined, clear: () => undefined };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const clear = () => clearTimeout(timer);

  return { controller, clear };
}

function extractTextFromChoice(choice: any): string {
  if (!choice) return '';

  const message = choice.message ?? choice.delta ?? {};
  const { content } = message;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue;
      if (typeof part === 'string') {
        return part;
      }
      if (typeof part.text === 'string') {
        return part.text;
      }
      if (typeof part.output_text === 'string') {
        return part.output_text;
      }
      if (typeof part.data === 'string') {
        return part.data;
      }
    }
  }

  if (typeof message.text === 'string') {
    return message.text;
  }

  return '';
}

function normalizeUsage(raw: any, latencyMs: number | undefined) {
  if (!raw) {
    return latencyMs ? { latencyMs } : undefined;
  }

  const promptTokens =
    raw.prompt_tokens ??
    raw.promptTokens ??
    raw.input_tokens ??
    raw.inputTokens;
  const completionTokens =
    raw.completion_tokens ??
    raw.completionTokens ??
    raw.output_tokens ??
    raw.outputTokens;
  const totalTokens =
    raw.total_tokens ?? raw.totalTokens ??
    (typeof promptTokens === 'number' && typeof completionTokens === 'number'
      ? promptTokens + completionTokens
      : undefined);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    latencyMs,
  };
}

function buildPayload(params: ProviderGenerateParams) {
  const payload: Record<string, any> = {
    model: params.model ?? DEFAULT_MODEL,
    messages: [
      {
        role: 'user',
        content: params.prompt,
      },
    ],
  };

  if (typeof params.temperature === 'number') {
    payload.temperature = params.temperature;
  }
  if (typeof params.topP === 'number') {
    payload.top_p = params.topP;
  }
  if (typeof params.maxOutputTokens === 'number') {
    payload.max_output_tokens = params.maxOutputTokens;
  }

  if (params.zodSchema) {
    try {
      const jsonSchema = z.toJSONSchema(params.zodSchema);
      payload.response_format = {
        type: 'json_schema',
        json_schema: {
          name: ensureSchemaName(params.schemaName),
          schema: jsonSchema,
          strict: true,
        },
      };
    } catch (error) {
      console.error('[Grok] Failed to convert Zod schema to JSON schema', error);
      throw new Error(
        error instanceof Error
          ? `Failed to convert schema: ${error.message}`
          : 'Failed to convert schema'
      );
    }
  }

  return payload;
}

export function createGrokAdapter(): ProviderAdapter {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'XAI_API_KEY is required to use the Grok provider. Set the environment variable and try again.'
    );
  }

  const baseUrl =
    process.env.XAI_API_BASE_URL?.replace(/\/$/, '') ?? 'https://api.x.ai/v1';

  return {
    name: PROVIDER_NAME,
    defaultModel: DEFAULT_MODEL,
    async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
      const { controller, clear } = buildAbortController(params.timeoutMs);
      const requestStartedAt = Date.now();

      try {
        const payload = buildPayload(params);
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller?.signal,
        });

        const responseText = await response.text();
        let parsed: any;

        try {
          parsed = responseText ? JSON.parse(responseText) : undefined;
        } catch (parseError) {
          console.error('[Grok] Failed to parse JSON response', parseError);
          throw new Error('Grok API returned a non-JSON response.');
        }

        if (!response.ok) {
          const message =
            parsed?.error?.message ||
            parsed?.message ||
            response.statusText ||
            'Unknown error';
          const code = parsed?.error?.code || parsed?.code;
          throw new Error(
            `Grok API error${code ? ` (${code})` : ''}: ${message}`
          );
        }

        const latencyMs = Date.now() - requestStartedAt;
        const choice = Array.isArray(parsed?.choices)
          ? parsed.choices[0]
          : undefined;
        const content = extractTextFromChoice(choice);

        if (!content) {
          throw new Error('Grok API returned an empty response.');
        }

        return {
          content,
          rawResponse: parsed,
          provider: PROVIDER_NAME,
          model: parsed?.model ?? payload.model,
          usage: normalizeUsage(parsed?.usage, latencyMs),
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error('Grok request timed out.');
        }
        throw error;
      } finally {
        clear();
      }
    },
  };
}

