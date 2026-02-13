import OpenAI, { AzureOpenAI } from 'openai';
import { z } from 'zod';
import type {
  ProviderAdapter,
  ProviderGenerateParams,
  ProviderGenerateResult
} from './types';

const OPENAI_PROVIDER_NAME = 'openai';
const AZURE_PROVIDER_NAME = 'azure-openai';
const OPENAI_DEFAULT_MODEL = 'gpt-4.1';

/**
 * Detect reasoning models that don't support temperature/topP parameters.
 */
function isReasoningModel(model: string): boolean {
  const reasoningModels = ['o1-preview', 'o1-mini', 'o1', 'o3-mini'];
  return reasoningModels.some(m => model.includes(m));
}

/**
 * Azure OpenAI requires root schema to be type: "object", not "array".
 * Wrap array schemas in an object wrapper.
 */
function wrapArraySchema(jsonSchema: Record<string, unknown>): {
  wrappedSchema: Record<string, unknown>;
  wasWrapped: boolean;
} {
  if (jsonSchema.type === 'array') {
    return {
      wrappedSchema: {
        type: 'object',
        properties: { items: jsonSchema },
        required: ['items'],
        additionalProperties: false
      },
      wasWrapped: true
    };
  }
  return { wrappedSchema: jsonSchema, wasWrapped: false };
}

/**
 * Unwrap array response if the schema was wrapped.
 * Azure returns: {"items": [...]} -> extract just [...]
 */
function unwrapArrayResponse(content: string, wasWrapped: boolean): string {
  if (!wasWrapped) return content;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && 'items' in parsed) {
      return JSON.stringify(parsed.items);
    }
  } catch {
    // Keep original if parsing fails
  }
  return content;
}

/**
 * Normalize usage metadata to our standard format.
 */
function normalizeUsage(
  usage: OpenAI.CompletionUsage | undefined,
  latencyMs: number
) {
  return {
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
    latencyMs
  };
}

/**
 * Shared generate implementation for both OpenAI and Azure OpenAI.
 */
async function generateWithClient(
  client: OpenAI | AzureOpenAI,
  params: ProviderGenerateParams,
  providerName: string,
  defaultModel: string,
  isAzure: boolean
): Promise<ProviderGenerateResult> {
  const requestStartedAt = Date.now();
  const model = params.model ?? defaultModel;

  // Build request parameters
  const requestParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages: [{ role: 'user', content: params.prompt }]
  };

  // Temperature and topP - skip for reasoning models
  if (!isReasoningModel(model)) {
    if (typeof params.temperature === 'number') {
      requestParams.temperature = params.temperature;
    }
    if (typeof params.topP === 'number') {
      requestParams.top_p = params.topP;
    }
  }

  // Max tokens - Azure uses max_completion_tokens, OpenAI uses max_tokens
  if (typeof params.maxOutputTokens === 'number') {
    if (isAzure) {
      requestParams.max_completion_tokens = params.maxOutputTokens;
    } else {
      requestParams.max_tokens = params.maxOutputTokens;
    }
  }

  // Structured output with JSON schema
  let wasArrayWrapped = false;
  if (params.zodSchema) {
    let jsonSchema = z.toJSONSchema(params.zodSchema) as Record<string, unknown>;

    // Azure requires object root type - wrap arrays
    if (isAzure) {
      const { wrappedSchema, wasWrapped } = wrapArraySchema(jsonSchema);
      jsonSchema = wrappedSchema;
      wasArrayWrapped = wasWrapped;
    }

    requestParams.response_format = {
      type: 'json_schema',
      json_schema: {
        name: params.schemaName?.trim() || 'ResponseSchema',
        schema: jsonSchema
      }
    };
  }

  try {
    const response = await client.chat.completions.create(
      requestParams,
      params.timeoutMs ? { timeout: params.timeoutMs } : undefined
    );

    const latencyMs = Date.now() - requestStartedAt;
    const choice = response.choices[0];
    let content = choice?.message?.content ?? '';

    if (!content) {
      throw new Error(`${providerName} returned an empty response.`);
    }

    // Unwrap array response if schema was wrapped for Azure
    if (isAzure && wasArrayWrapped) {
      content = unwrapArrayResponse(content, true);
    }

    return {
      content,
      rawResponse: response,
      provider: providerName,
      model: response.model ?? model,
      usage: normalizeUsage(response.usage, latencyMs)
    };
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      throw new Error(
        `${providerName} API error (${error.status}): ${error.message}`
      );
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${providerName} request timed out.`);
    }
    throw error;
  }
}

/**
 * Create an OpenAI adapter using the official SDK.
 */
export function createOpenAIAdapter(): ProviderAdapter {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is required to use the OpenAI provider.'
    );
  }

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL,
    organization: process.env.OPENAI_ORG_ID
  });

  return {
    name: OPENAI_PROVIDER_NAME,
    defaultModel: OPENAI_DEFAULT_MODEL,
    generate: (params) =>
      generateWithClient(
        client,
        params,
        OPENAI_PROVIDER_NAME,
        OPENAI_DEFAULT_MODEL,
        false
      )
  };
}

/**
 * Create an Azure OpenAI adapter using the official SDK.
 */
export function createAzureOpenAIAdapter(): ProviderAdapter {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '');
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion =
    process.env.AZURE_OPENAI_API_VERSION || '2024-10-01-preview';

  if (!apiKey || !endpoint || !deployment) {
    throw new Error(
      'Azure OpenAI requires AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_DEPLOYMENT.'
    );
  }

  const client = new AzureOpenAI({
    apiKey,
    endpoint,
    deployment,
    apiVersion
  });

  return {
    name: AZURE_PROVIDER_NAME,
    defaultModel: deployment,
    generate: (params) =>
      generateWithClient(
        client,
        params,
        AZURE_PROVIDER_NAME,
        deployment,
        true
      )
  };
}
