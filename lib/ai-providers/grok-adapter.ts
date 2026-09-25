import { z } from 'zod';
import { initialAIAttempt } from '../initial-ai-context';
import type { ProviderAdapter, ProviderGenerateParams, ProviderGenerateResult } from './types';

const DEFAULT_MODEL = 'grok-4-1-fast-non-reasoning';
const PROVIDER_NAME = 'grok';

// JSON Schema properties not supported by Grok's structured outputs
// See: https://docs.x.ai/docs/guides/structured-outputs
const UNSUPPORTED_SCHEMA_PROPS = [
  'minLength', 'maxLength',           // string constraints
  'minItems', 'maxItems',             // array constraints
  'minContains', 'maxContains',       // array contains constraints
  '$schema',                          // draft specifier not needed
];

/**
 * Recursively removes JSON Schema properties that Grok doesn't support.
 * This allows us to use Zod schemas with constraints while still being
 * compatible with Grok's structured output API.
 */
function sanitizeSchemaForGrok(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;

  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForGrok);
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_PROPS.includes(key)) continue;
    result[key] = sanitizeSchemaForGrok(value);
  }
  return result;
}

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
      const sanitizedSchema = sanitizeSchemaForGrok(jsonSchema);
      payload.response_format = {
        type: 'json_schema',
        json_schema: {
          name: ensureSchemaName(params.schemaName),
          schema: sanitizedSchema,
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
        const { responseText } = await initialAIAttempt(async () => {
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
          if (!response.ok) {
            let errorBody;
            try { errorBody = JSON.parse(responseText); } catch { /* Preserve HTTP status even for non-JSON errors. */ }
            const message = errorBody?.error?.message || errorBody?.message || response.statusText || 'Unknown error';
            const code = errorBody?.error?.code || errorBody?.code;
            throw Object.assign(new Error(`Grok API error${code ? ` (${code})` : ''}: ${message}`), { status: response.status });
          }
          return { responseText };
        });
        let parsed: any;

        try {
          parsed = responseText ? JSON.parse(responseText) : undefined;
        } catch (parseError) {
          console.error('[Grok] Failed to parse JSON response', parseError);
          throw new Error('Grok API returned a non-JSON response.');
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
