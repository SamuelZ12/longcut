import type { ProviderAdapter, ProviderGenerateParams, ProviderGenerateResult } from './types';

const PROVIDER_NAME = 'minimax';
const DEFAULT_MODEL = 'MiniMax-M2.7';
const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';

function buildAbortController(timeoutMs?: number) {
  if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === 'undefined') {
    return { controller: undefined, clear: () => undefined };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return {
    controller,
    clear: () => clearTimeout(timer),
  };
}

function extractTextFromChoice(choice: any): string {
  if (!choice) return '';

  const message = choice.message ?? choice.delta ?? {};
  const content = message.content ?? choice.text ?? message.text;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') {
        return part;
      }

      if (typeof part?.text === 'string') {
        return part.text;
      }

      if (typeof part?.content === 'string') {
        return part.content;
      }
    }
  }

  return '';
}

function stripReasoningBlocks(content: string): string {
  return content
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

function normalizeUsage(raw: any, latencyMs: number | undefined) {
  if (!raw) {
    return latencyMs ? { latencyMs } : undefined;
  }

  const promptTokens =
    raw.prompt_tokens ?? raw.promptTokens ?? raw.input_tokens ?? raw.inputTokens;
  const completionTokens =
    raw.completion_tokens ??
    raw.completionTokens ??
    raw.output_tokens ??
    raw.outputTokens;
  const totalTokens =
    raw.total_tokens ??
    raw.totalTokens ??
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
  const payload: Record<string, unknown> = {
    model: params.model ?? DEFAULT_MODEL,
    messages: [
      {
        role: 'user',
        content: params.prompt,
      },
    ],
    reasoning_split: true,
  };

  if (typeof params.temperature === 'number') {
    payload.temperature = params.temperature;
  }

  if (typeof params.topP === 'number') {
    payload.top_p = params.topP;
  }

  if (typeof params.maxOutputTokens === 'number') {
    payload.max_tokens = params.maxOutputTokens;
  }

  if (params.metadata) {
    payload.metadata = params.metadata;
  }

  return payload;
}

function buildMiniMaxError(response: Response, parsed: any): Error {
  const status = response.status;
  const providerCode = parsed?.base_resp?.status_code;
  const message =
    parsed?.base_resp?.status_msg ??
    parsed?.error?.message ??
    parsed?.message ??
    response.statusText ??
    'Unknown error';
  const lowerMessage = String(message).toLowerCase();

  if (status === 401 || status === 403) {
    return new Error(`MiniMax API authentication failed: ${message}`);
  }

  if (status === 429 || providerCode === 1002 || lowerMessage.includes('rate limit')) {
    return new Error(`MiniMax API rate limit: ${message}`);
  }

  if (status === 408 || lowerMessage.includes('timeout')) {
    return new Error(`MiniMax API timeout: ${message}`);
  }

  if (status >= 500) {
    return new Error(`MiniMax API service unavailable: ${message}`);
  }

  return new Error(
    `MiniMax API error${providerCode ? ` (${providerCode})` : ''}: ${message}`
  );
}

export function createMiniMaxAdapter(): ProviderAdapter {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new Error(
      'MINIMAX_API_KEY is required to use the MiniMax provider. Set the environment variable and try again.'
    );
  }

  const baseUrl =
    process.env.MINIMAX_API_BASE_URL?.replace(/\/$/, '') ?? DEFAULT_BASE_URL;

  return {
    name: PROVIDER_NAME,
    defaultModel: DEFAULT_MODEL,
    async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
      const payload = buildPayload(params);
      const { controller, clear } = buildAbortController(params.timeoutMs);
      const requestStartedAt = Date.now();

      try {
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
        } catch {
          throw new Error('MiniMax API returned a non-JSON response.');
        }

        if (!response.ok) {
          throw buildMiniMaxError(response, parsed);
        }

        const latencyMs = Date.now() - requestStartedAt;
        const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
        const content = stripReasoningBlocks(extractTextFromChoice(choice));

        if (!content) {
          throw new Error('MiniMax API returned an empty response.');
        }

        return {
          content,
          rawResponse: parsed,
          provider: PROVIDER_NAME,
          model: parsed?.model ?? String(payload.model),
          usage: normalizeUsage(parsed?.usage, latencyMs),
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error('MiniMax API timeout: request timed out.');
        }

        throw error;
      } finally {
        clear();
      }
    },
  };
}
