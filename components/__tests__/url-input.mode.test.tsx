import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function withEnv<T>(values: Record<string, string | undefined>, run: () => T) {
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
    return run();
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

function loadUrlInput() {
  const modulePath = '@/components/url-input';
  delete require.cache[require.resolve(modulePath)];

  return require(modulePath) as typeof import('@/components/url-input');
}

test('UrlInput hides mode selector when MiniMax forces smart mode on the client', () => {
  withEnv({ NEXT_PUBLIC_AI_PROVIDER: 'minimax' }, () => {
    const { UrlInput } = loadUrlInput();
    const markup = renderToStaticMarkup(
      <UrlInput onSubmit={() => {}} mode="fast" onModeChange={() => {}} />
    );

    assert.doesNotMatch(markup, /data-slot="select-trigger"/);
    assert.doesNotMatch(markup, />Fast</);
  });
});

test('UrlInput shows mode selector when Gemini does not force smart mode on the client', () => {
  withEnv({ NEXT_PUBLIC_AI_PROVIDER: 'gemini' }, () => {
    const { UrlInput } = loadUrlInput();
    const markup = renderToStaticMarkup(
      <UrlInput onSubmit={() => {}} mode="fast" onModeChange={() => {}} />
    );

    assert.match(markup, /data-slot="select-trigger"/);
    assert.match(markup, />Fast</);
  });
});

test('UrlInput shows mode selector when NEXT_PUBLIC_AI_PROVIDER is absent', () => {
  withEnv({ NEXT_PUBLIC_AI_PROVIDER: undefined }, () => {
    const { UrlInput } = loadUrlInput();
    const markup = renderToStaticMarkup(
      <UrlInput onSubmit={() => {}} mode="fast" onModeChange={() => {}} />
    );

    assert.match(markup, /data-slot="select-trigger"/);
    assert.match(markup, />Fast</);
  });
});
