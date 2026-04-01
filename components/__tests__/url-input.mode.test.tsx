import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let reloadToken = 0;

async function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => T | Promise<T>
) {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function loadUrlInput() {
  const moduleUrl = new URL('../url-input.tsx', import.meta.url);
  moduleUrl.searchParams.set('reload', String(reloadToken++));

  return (await import(moduleUrl.href)) as typeof import('@/components/url-input');
}

test('UrlInput hides mode selector when MiniMax forces smart mode on the client', async () => {
  await withEnv({ NEXT_PUBLIC_AI_PROVIDER: 'minimax' }, async () => {
    const { UrlInput } = await loadUrlInput();
    const markup = renderToStaticMarkup(
      <UrlInput onSubmit={() => {}} mode="fast" onModeChange={() => {}} />
    );

    assert.doesNotMatch(markup, /data-slot="select-trigger"/);
    assert.doesNotMatch(markup, />Fast</);
  });
});

test('UrlInput shows mode selector when Gemini does not force smart mode on the client', async () => {
  await withEnv({ NEXT_PUBLIC_AI_PROVIDER: 'gemini' }, async () => {
    const { UrlInput } = await loadUrlInput();
    const markup = renderToStaticMarkup(
      <UrlInput onSubmit={() => {}} mode="fast" onModeChange={() => {}} />
    );

    assert.match(markup, /data-slot="select-trigger"/);
    assert.match(markup, />Fast</);
  });
});

test('UrlInput shows mode selector when NEXT_PUBLIC_AI_PROVIDER is absent', async () => {
  await withEnv({ NEXT_PUBLIC_AI_PROVIDER: undefined }, async () => {
    const { UrlInput } = await loadUrlInput();
    const markup = renderToStaticMarkup(
      <UrlInput onSubmit={() => {}} mode="fast" onModeChange={() => {}} />
    );

    assert.match(markup, /data-slot="select-trigger"/);
    assert.match(markup, />Fast</);
  });
});
