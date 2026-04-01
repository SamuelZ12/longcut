import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { createMiniMaxAdapter } from '../ai-providers/minimax-adapter';

function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>) {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return run().finally(() => {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function withMockFetch<T>(mockFetch: typeof fetch, run: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test('MiniMax adapter strips <think> tags and normalizes usage', async () => {
  await withEnv({ MINIMAX_API_KEY: 'test-key' }, async () => {
    await withMockFetch(
      async () =>
        new Response(
          JSON.stringify({
            model: 'MiniMax-M2.7',
            choices: [
              {
                message: {
                  content: '<think>hidden reasoning</think>  {"ok":true}  ',
                },
              },
            ],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              total_tokens: 18,
            },
          }),
          { status: 200 }
        ),
      async () => {
        const adapter = createMiniMaxAdapter();
        const result = await adapter.generate({ prompt: 'Return JSON' });

        assert.equal(result.content, '{"ok":true}');
        assert.equal(result.provider, 'minimax');
        assert.equal(result.model, 'MiniMax-M2.7');
        assert.deepEqual(result.usage, {
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
          latencyMs: result.usage?.latencyMs,
        });
        assert.equal(typeof result.usage?.latencyMs, 'number');
      }
    );
  });
});

test('MiniMax adapter maps 429 base_resp 1002 to retryable rate-limit wording', async () => {
  await withEnv({ MINIMAX_API_KEY: 'test-key' }, async () => {
    await withMockFetch(
      async () =>
        new Response(
          JSON.stringify({
            base_resp: {
              status_code: 1002,
              status_msg: 'rate limited',
            },
          }),
          { status: 429, statusText: 'Too Many Requests' }
        ),
      async () => {
        const adapter = createMiniMaxAdapter();

        await assert.rejects(
          () => adapter.generate({ prompt: 'Hello' }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /MiniMax API rate limit/i);
            return true;
          }
        );
      }
    );
  });
});

test('MiniMax adapter uses prompt-based schema compatibility when zodSchema is provided', async () => {
  await withEnv({ MINIMAX_API_KEY: 'test-key' }, async () => {
    let requestBody: any;

    await withMockFetch(
      async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));

        return new Response(
          JSON.stringify({
            model: 'MiniMax-M2.7',
            choices: [
              {
                message: {
                  content: '<think>hidden reasoning</think>{"title":"MiniMax"}',
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
      async () => {
        const adapter = createMiniMaxAdapter();
        const result = await adapter.generate({
          prompt: 'Return a title object',
          schemaName: 'TopicTitle',
          zodSchema: z.object({
            title: z.string(),
          }),
        });

        assert.match(requestBody.messages[0].content, /Return a title object/);
        assert.match(requestBody.messages[0].content, /TopicTitle/);
        assert.match(requestBody.messages[0].content, /Return strict JSON/i);
        assert.match(requestBody.messages[0].content, /"title"/);
        assert.equal(result.content, '{"title":"MiniMax"}');
      }
    );
  });
});
