import type { ProviderAdapter, ProviderGenerateParams, ProviderGenerateResult } from './types';

const DEFAULT_MODEL = 'deepseek-chat';
const PROVIDER_NAME = 'deepseek';

const DEFAULT_SEARCH_COUNT = 5;
const MAX_TOOL_STEPS = 2;
const BRAVE_SEARCH_BASE_URL = 'https://api.search.brave.com/res/v1/web/search';

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

function buildMessages(params: ProviderGenerateParams, enableSearch: boolean): any[] {
  const messages: any[] = [];

  if (enableSearch) {
    messages.push({
      role: 'system',
      content:
        'You can access current information by calling the web_search tool when needed. ' +
        'If the question requires up-to-date facts, call web_search. Otherwise answer directly.',
    });
  }

  messages.push({
    role: 'user',
    content: params.prompt,
  });

  return messages;
}

function buildTools(enableSearch: boolean, braveApiKey?: string): any[] | undefined {
  if (!enableSearch || !braveApiKey) return undefined;
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for up-to-date information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            count: {
              type: 'integer',
              description: 'Number of results (1-5).',
            },
          },
          required: ['query'],
        },
      },
    },
  ];
}

function parseToolArguments(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeBraveResults(payload: any, maxResults: number) {
  const items = Array.isArray(payload?.web?.results)
    ? payload.web.results
    : Array.isArray(payload?.results)
      ? payload.results
      : [];

  return items.slice(0, maxResults).map((item: any) => ({
    title: item?.title ?? item?.name ?? '',
    url: item?.url ?? item?.link ?? '',
    description: item?.description ?? item?.snippet ?? item?.summary ?? '',
    age: item?.age ?? item?.page_age ?? undefined,
  }));
}

async function braveWebSearch(
  braveApiKey: string,
  query: string,
  count: number,
  signal?: AbortSignal
): Promise<{ query: string; results: Array<{ title: string; url: string; description: string; age?: string }> }> {
  const url = new URL(BRAVE_SEARCH_BASE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': braveApiKey,
    },
    signal,
  });

  const text = await response.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    const message =
      parsed?.error?.message ||
      parsed?.message ||
      response.statusText ||
      'Unknown error';
    throw new Error(`Brave Search error: ${message}`);
  }

  return {
    query,
    results: normalizeBraveResults(parsed, count),
  };
}

function extractToolCalls(choice: any): any[] {
  const message = choice?.message ?? {};
  const toolCalls = message.tool_calls ?? message.toolCalls ?? [];
  return Array.isArray(toolCalls) ? toolCalls : [];
}

async function runToolCall(
  toolCall: any,
  braveApiKey?: string,
  signal?: AbortSignal
): Promise<{ query?: string; results?: Array<{ title: string; url: string; description: string; age?: string }>; error?: string }> {
  const name = toolCall?.function?.name;
  if (name !== 'web_search') {
    return { error: `Unsupported tool: ${name ?? 'unknown'}` };
  }

  if (!braveApiKey) {
    return { error: 'Brave Search API key is not configured.' };
  }

  const args = parseToolArguments(toolCall?.function?.arguments);
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { error: 'Missing search query.' };
  }

  const countRaw = typeof args.count === 'number' ? args.count : Number(args.count);
  const count = Number.isFinite(countRaw)
    ? clampNumber(countRaw, 1, 5)
    : DEFAULT_SEARCH_COUNT;

  return braveWebSearch(braveApiKey, query, count, signal);
}

// Get the appropriate model based on whether search is enabled
function getModelForRequest(params: ProviderGenerateParams, enableSearch: boolean): string {
  // If user specified a model, use it
  if (params.model) {
    return params.model;
  }
  if (enableSearch) {
    return process.env.DEEPSEEK_SEARCH_MODEL ?? DEFAULT_MODEL;
  }
  return DEFAULT_MODEL;
}

function buildPayload(options: {
  params: ProviderGenerateParams;
  messages: any[];
  tools?: any[];
  includeResponseFormat: boolean;
  model: string;
}): Record<string, any> {
  const { params, messages, tools, includeResponseFormat, model } = options;

  const payload: Record<string, any> = {
    model,
    messages,
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

  if (tools && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  if (includeResponseFormat && params.zodSchema) {
    payload.response_format = { type: 'json_object' };
  }

  return payload;
}

export function createDeepSeekAdapter(): ProviderAdapter {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY is required to use the DeepSeek provider. Set the environment variable and try again.'
    );
  }

  const baseUrl =
    process.env.DEEPSEEK_API_BASE_URL?.replace(/\/$/, '') ?? 'https://api.deepseek.com';

  // Check if web search is enabled
  const enableSearch = process.env.DEEPSEEK_ENABLE_SEARCH === 'true';
  const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;
  const canUseSearchTools = enableSearch && !!braveApiKey;

  if (enableSearch && !braveApiKey) {
    console.warn(
      '[DeepSeek] DEEPSEEK_ENABLE_SEARCH is true but BRAVE_SEARCH_API_KEY is missing. Search tools disabled.'
    );
  }

  return {
    name: PROVIDER_NAME,
    defaultModel: DEFAULT_MODEL,
    async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
      const { controller, clear } = buildAbortController(params.timeoutMs);
      const requestStartedAt = Date.now();

      try {
        const resolvedModel = getModelForRequest(params, enableSearch);
        const messages = buildMessages(params, canUseSearchTools);
        const tools = buildTools(canUseSearchTools, braveApiKey);
        let toolUsed = false;
        let allowResponseFormat = !!params.zodSchema;

        for (let step = 0; step <= MAX_TOOL_STEPS; step += 1) {
          const payload = buildPayload({
            params,
            messages,
            tools,
            includeResponseFormat: allowResponseFormat,
            model: resolvedModel,
          });

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
            console.error('[DeepSeek] Failed to parse JSON response', parseError);
            throw new Error('DeepSeek API returned a non-JSON response.');
          }

          if (!response.ok) {
            const message =
              parsed?.error?.message ||
              parsed?.message ||
              response.statusText ||
              'Unknown error';
            const code = parsed?.error?.code || parsed?.code;
            const lowerMessage = String(message).toLowerCase();

            if (
              allowResponseFormat &&
              (lowerMessage.includes('response_format') ||
                lowerMessage.includes('json_object') ||
                lowerMessage.includes('json_schema'))
            ) {
              console.warn(
                '[DeepSeek] response_format rejected; retrying without response_format.'
              );
              allowResponseFormat = false;
              continue;
            }

            throw new Error(
              `DeepSeek API error${code ? ` (${code})` : ''}: ${message}`
            );
          }

          const choice = Array.isArray(parsed?.choices)
            ? parsed.choices[0]
            : undefined;

          const toolCalls = extractToolCalls(choice);
          if (toolCalls.length > 0) {
            toolUsed = true;

            messages.push({
              role: 'assistant',
              content: choice?.message?.content ?? null,
              tool_calls: toolCalls,
            });

            const toolResults = await Promise.all(
              toolCalls.map((call: any) => runToolCall(call, braveApiKey, controller?.signal))
            );

            toolResults.forEach((result, index) => {
              const call = toolCalls[index];
              messages.push({
                role: 'tool',
                tool_call_id: call?.id ?? call?.function?.name ?? `web_search_${index}`,
                content: JSON.stringify(result),
              });
            });

            continue;
          }

          const latencyMs = Date.now() - requestStartedAt;
          const content = extractTextFromChoice(choice);

          if (!content) {
            throw new Error('DeepSeek API returned an empty response.');
          }

          return {
            content,
            rawResponse: parsed,
            provider: PROVIDER_NAME,
            model: parsed?.model ?? resolvedModel,
            usage: normalizeUsage(parsed?.usage, latencyMs),
          };
        }

        throw new Error('DeepSeek API returned no final response after tool calls.');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error('DeepSeek request timed out.');
        }
        throw error;
      } finally {
        clear();
      }
    },
  };
}
