import test from 'node:test';
import assert from 'node:assert/strict';

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

async function importFreshValidationModule() {
  return import(new URL(`../validation.ts?ts=${Date.now()}`, import.meta.url).href);
}

test('model schema defaults to MiniMax model when only MINIMAX_API_KEY is present', async () => {
  await withEnv(
    {
      AI_PROVIDER: undefined,
      NEXT_PUBLIC_AI_PROVIDER: undefined,
      XAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      MINIMAX_API_KEY: 'test-minimax-key',
      AI_DEFAULT_MODEL: undefined,
    },
    async () => {
      const { modelSchema } = await importFreshValidationModule();
      assert.equal(modelSchema.parse(undefined), 'MiniMax-M2.7');
    }
  );
});
