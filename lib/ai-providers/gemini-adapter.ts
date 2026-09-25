import {
  GoogleGenerativeAI,
  SchemaType,
  type GenerationConfig,
} from '@google/generative-ai';
import { z } from 'zod';
import { initialAIAttempt } from '../initial-ai-context';
import type { ProviderAdapter, ProviderGenerateParams, ProviderGenerateResult } from './types';

const PROVIDER_NAME = 'gemini';
const MODEL_CASCADE = [
  'gemini-2.5-flash-lite',
  'gemini-3-flash',
  'gemini-3-pro',
] as const;

type GeminiModel = (typeof MODEL_CASCADE)[number];

function isValidModel(model?: string): model is GeminiModel {
  return !!model && MODEL_CASCADE.includes(model as GeminiModel);
}

function isRetryableError(error: any): boolean {
  if (!error) return false;
  const message = typeof error.message === 'string' ? error.message : '';
  const status = error.status ?? error.code;
  return (
    status === 503 ||
    status === 429 ||
    message.includes('503') ||
    message.includes('429') ||
    message.toLowerCase().includes('overload') ||
    message.toLowerCase().includes('rate limit')
  );
}

function describeError(error: any): string {
  if (!error) return 'unknown error';
  const status = error.status ?? error.code;
  const message =
    error?.message ??
    (typeof error === 'string' ? error : error?.toString?.() ?? '');

  if (status === 503 || message.includes('503')) return 'overloaded';
  if (status === 429 || message.toLowerCase().includes('rate limit'))
    return 'rate limited';
  if (status === 401 || message.toLowerCase().includes('unauthorized'))
    return 'authentication failed';
  if (status === 400 || message.includes('400')) return 'invalid request';
  if (status === 408 || message.toLowerCase().includes('timeout'))
    return 'timeout';

  return 'unknown error';
}

function convertToGeminiSchema(jsonSchema: any): any {
  if (!jsonSchema) return undefined;

  if (jsonSchema.anyOf || jsonSchema.oneOf) {
    const schemas = jsonSchema.anyOf || jsonSchema.oneOf;
    const nonNullSchemas = schemas.filter((schema: any) => schema.type !== 'null');

    if (nonNullSchemas.length === 1) {
      const converted = convertToGeminiSchema(nonNullSchemas[0]);
      if (converted) {
        converted.nullable = true;
      }
      return converted;
    }

    if (nonNullSchemas.length > 0) {
      return convertToGeminiSchema(nonNullSchemas[0]);
    }
  }

  if (jsonSchema.type === 'object') {
    const properties: Record<string, any> = {};
    const required: string[] = jsonSchema.required || [];

    for (const [key, value] of Object.entries(jsonSchema.properties || {})) {
      properties[key] = convertToGeminiSchema(value);
    }

    return {
      type: SchemaType.OBJECT,
      properties,
      required,
    };
  }

  if (jsonSchema.type === 'array') {
    const arraySchema: Record<string, any> = {
      type: SchemaType.ARRAY,
      items: jsonSchema.items
        ? convertToGeminiSchema(jsonSchema.items)
        : { type: SchemaType.STRING },
    };

    if (typeof jsonSchema.minItems === 'number') {
      arraySchema.minItems = jsonSchema.minItems;
    }
    if (typeof jsonSchema.maxItems === 'number') {
      arraySchema.maxItems = jsonSchema.maxItems;
    }

    return arraySchema;
  }

  if (jsonSchema.type === 'string') {
    const stringSchema: Record<string, any> = { type: SchemaType.STRING };
    if (typeof jsonSchema.pattern === 'string') {
      stringSchema.pattern = jsonSchema.pattern;
    }
    return stringSchema;
  }

  if (jsonSchema.type === 'number' || jsonSchema.type === 'integer') {
    return { type: SchemaType.NUMBER };
  }

  if (jsonSchema.type === 'boolean') {
    return { type: SchemaType.BOOLEAN };
  }

  if (Array.isArray(jsonSchema.enum)) {
    // Gemini's SchemaType doesn't expose an explicit ENUM type; encode as string with enum constraint
    return { type: SchemaType.STRING, enum: jsonSchema.enum } as any;
  }

  return { type: SchemaType.STRING };
}

function buildGenerationConfig(params: ProviderGenerateParams): GenerationConfig {
  const config: GenerationConfig = {};

  if (typeof params.temperature === 'number') {
    config.temperature = params.temperature;
  }
  if (typeof params.topP === 'number') {
    config.topP = params.topP;
  }
  if (typeof params.maxOutputTokens === 'number') {
    config.maxOutputTokens = params.maxOutputTokens;
  }

  if (params.zodSchema) {
    try {
      const jsonSchema = z.toJSONSchema(params.zodSchema);
      const geminiSchema = convertToGeminiSchema(jsonSchema);
      config.responseMimeType = 'application/json';
      config.responseSchema = geminiSchema;
    } catch (error) {
      console.error(
        '[Gemini] Failed to convert Zod schema to Gemini schema',
        error
      );
      throw new Error(
        error instanceof Error
          ? `Failed to convert schema: ${error.message}`
          : 'Failed to convert schema'
      );
    }
  }

  return config;
}

function buildModelList(model?: string) {
  if (isValidModel(model)) {
    return [
      model,
      ...MODEL_CASCADE.filter((candidate) => candidate !== model),
    ];
  }
  return [...MODEL_CASCADE];
}

function normalizeUsageMetadata(metadata: any, latencyMs: number) {
  if (!metadata) {
    return { latencyMs };
  }

  const promptTokens =
    metadata.promptTokenCount ?? metadata.prompt_tokens ?? metadata.input_tokens;
  const completionTokens =
    metadata.candidatesTokenCount ??
    metadata.outputTokenCount ??
    metadata.output_tokens;
  const totalTokens = metadata.totalTokenCount ?? metadata.total_tokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    latencyMs,
  };
}

export function createGeminiAdapter(): ProviderAdapter {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is required to use the Gemini provider. Set the environment variable and try again.'
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    name: PROVIDER_NAME,
    defaultModel: MODEL_CASCADE[0],
    async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
      const models = buildModelList(params.model);
      let lastError: unknown;
      const promptLength = params.prompt.length;

      for (const modelName of models) {
        try {
          const generationConfig = buildGenerationConfig(params);
          const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig,
          });

          const requestStart = Date.now();
          const result = await initialAIAttempt(async () => {
            const generatePromise = model.generateContent(params.prompt);
            return params.timeoutMs
            ? await Promise.race([
                generatePromise,
                new Promise((_, reject) =>
                  setTimeout(
                    () => reject(new Error('Request timeout')),
                    params.timeoutMs
                  )
                ),
              ])
              : await generatePromise;
          });

          const latencyMs = Date.now() - requestStart;
          const geminiResponse = (result as any).response;
          const response = geminiResponse?.text?.();

          if (typeof response === 'string' && response.trim().length > 0) {
            const usage = normalizeUsageMetadata(
              geminiResponse?.usageMetadata,
              latencyMs
            );

            console.log(
              `[Gemini][${modelName}] latency=${latencyMs}ms promptChars=${promptLength} ` +
                `promptTokens=${usage.promptTokens ?? 'n/a'} completionTokens=${
                  usage.completionTokens ?? 'n/a'
                } totalTokens=${usage.totalTokens ?? 'n/a'}`
            );

            return {
              content: response,
              rawResponse: geminiResponse,
              provider: PROVIDER_NAME,
              model: modelName,
              usage,
            };
          }

          console.warn(
            `[Gemini] Model ${modelName} returned empty response, trying next...`
          );
        } catch (error) {
          lastError = error;
          const description = describeError(error);

          if (!isRetryableError(error)) {
            console.error(
              `[Gemini] Model ${modelName} failed with non-retryable error (${description}):`,
              error
            );
            throw new Error(
              `Gemini API error (${description}): ${
                error instanceof Error ? error.message : 'Unknown error'
              }`
            );
          }

          console.warn(
            `[Gemini] Model ${modelName} ${description}, attempting next fallback...`
          );
        }
      }

      const description = describeError(lastError);
      throw new Error(
        `All Gemini models failed. Last error type: ${description}. ${
          lastError instanceof Error ? lastError.message : 'Unknown error'
        }`
      );
    },
  };
}
