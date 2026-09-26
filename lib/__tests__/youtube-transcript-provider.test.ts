import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import {
  fetchYouTubeTranscript,
} from '../youtube-transcript-provider';

function withMockFetch(
  mockFetch: typeof fetch,
  run: () => Promise<void>
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

// Minimal YouTube watch page HTML with INNERTUBE_API_KEY embedded
// (our provider scrapes this before calling InnerTube)
const FAKE_WATCH_PAGE = `
  <html><body><script>
    ytcfg.set({"INNERTUBE_API_KEY":"AIzaFakeKey","INNERTUBE_CLIENT_VERSION":"2.20250326","VISITOR_DATA":"fakeVisitor"});
  </script></body></html>
`;

const captionPlayer = (languageCode = 'es', kind?: string) => JSON.stringify({
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { baseUrl: 'https://captions.test/en', languageCode: 'en' },
    { baseUrl: 'https://captions.test/es', languageCode, kind },
  ] } },
});
const CAPTION_XML = '<text start="0" dur="1">hola</text>';

for (const [preferred, language, kind] of [
  ['ES', 'es', undefined],
  ['es', 'ES', undefined],
  ['ES-mx', 'es-MX', undefined],
  ['ES-ar', 'es-MX', undefined],
  ['ES', 'es', 'asr'],
]) {
  test(`language matching: ${preferred} selects ${language} (${kind ?? 'manual'}) before English`, async () => {
    const captions: string[] = [];
    await withMockFetch(async (input) => {
      const url = String(input);
      if (url.includes('/watch')) return new Response(FAKE_WATCH_PAGE);
      if (url.includes('/player')) return new Response(captionPlayer(language, kind));
      captions.push(url);
      return new Response(url.includes('/es') ? CAPTION_XML : '<text start="0" dur="1">hello</text>');
    }, async () => {
      // Uppercase request comes first: no lowercase request can warm a cache for it.
      const result = await fetchYouTubeTranscript('video123', preferred);
      assert.equal(result?.language, language);
      assert.deepEqual(result?.availableLanguages, ['en', language]);
      assert.equal(result?.segments[0].text, 'hola');
      assert.deepEqual(captions, ['https://captions.test/es&fmt=3']);
    });
  });
}

test('already-aborted signal rejects without fetching', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Leader deadline', 'TimeoutError');
  controller.abort(reason);
  let requests = 0;
  await withMockFetch(async () => {
    requests++;
    return new Response('');
  }, async () => {
    await assert.rejects(fetchYouTubeTranscript('video123', 'es', undefined, controller.signal), error => error === reason);
    assert.equal(requests, 0);
  });
});

for (const stage of ['watch', 'consent', 'Android', 'Web', 'iOS', 'caption']) {
  for (const phase of ['fetch', 'body']) {
    test(`abort during ${stage} ${phase} rejects promptly without subsequent requests`, async () => {
      const controller = new AbortController();
      const reason = new DOMException('Leader cancelled', 'AbortError');
      const requests: { stage: string; signal: AbortSignal | null | undefined }[] = [];
      let watchCalls = 0;
      let reached!: () => void;
      const started = new Promise<void>(resolve => { reached = resolve; });
      let release!: (value: never) => void;
      const pending = new Promise<never>(resolve => { release = resolve; });
      await withMockFetch(async (input, init) => {
        const url = String(input);
        const current = url.includes('/watch')
          ? (++watchCalls === 1 ? 'watch' : 'consent')
          : url.includes('/player')
            ? ({ ANDROID: 'Android', WEB: 'Web', IOS: 'iOS' } as Record<string, string>)[JSON.parse(String(init?.body)).context.client.clientName]
            : 'caption';
        requests.push({ stage: current, signal: init?.signal });
        if (current === stage) {
          if (phase === 'fetch') {
            reached();
            return pending;
          }
          const response = new Response('');
          const read = () => { reached(); return pending; };
          response.text = read;
          response.json = read;
          return response;
        }
        if (current === 'watch') {
          return new Response(stage === 'consent'
            ? '<form action="https://consent.youtube.com/s"><input name="v" value="test"></form>'
            : FAKE_WATCH_PAGE);
        }
        if (current === 'Android' || current === 'Web') {
          if (stage === 'Web' || stage === 'iOS') return new Response('', { status: 429 });
        }
        return new Response(captionPlayer());
      }, async () => {
        const result = fetchYouTubeTranscript('video123', 'es', 60, controller.signal);
        await started;
        const count = requests.length;
        controller.abort(reason);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await assert.rejects(Promise.race([
            result,
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Cancellation did not settle within 250ms')), 250); }),
          ]), error => error === reason);
          assert.equal(requests.length, count);
          assert.ok(requests.every(request => request.signal === controller.signal), 'Every nested fetch must receive leader signal');
          assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'Cancellation must clean up abort listeners');
        } finally {
          clearTimeout(timeout);
          // Drain the mocked operation, including on regression failures.
          release((phase === 'fetch' ? new Response('') : '') as never);
          await result.catch(() => {});
          await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(requests.length, count, 'Late completion must not restart fallback chain');
      });
    });
  }
}

test('AbortError from fetch is not swallowed even without a supplied signal', async () => {
  const reason = new DOMException('Fetch cancelled', 'AbortError');
  let requests = 0;
  await withMockFetch(async () => {
    requests++;
    throw reason;
  }, async () => {
    await assert.rejects(fetchYouTubeTranscript('video123'), error => error === reason);
    assert.equal(requests, 1);
  });
});

test('live signal permits consent retry and client fallback, cleaning up listeners', async () => {
  const controller = new AbortController();
  let watches = 0;
  let players = 0;
  let requests = 0;
  await withMockFetch(async (input, init) => {
    requests++;
    assert.equal(init?.signal, controller.signal);
    const url = String(input);
    if (url.includes('/watch')) {
      if (++watches === 1) {
        return new Response('<form action="https://consent.youtube.com/s"><input name="v" value="test"></form>');
      }
      assert.equal(new Headers(init?.headers).get('Cookie'), 'CONSENT=YES+test');
      return new Response(FAKE_WATCH_PAGE);
    }
    if (url.includes('/player')) {
      if (++players === 1) return new Response('', { status: 429 });
      return new Response(captionPlayer());
    }
    assert.equal(url, 'https://captions.test/es&fmt=3');
    return new Response(CAPTION_XML);
  }, async () => {
    const result = await fetchYouTubeTranscript('video123', 'ES', 60, controller.signal);
    assert.equal(result?.language, 'es');
    assert.equal(result?.segments[0].text, 'hola');
    assert.equal(requests, 5);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});

for (const outcome of ['rate-limit', 'network-error', 'empty-caption']) {
  test(`abort accompanying ${outcome} prevents next client and preserves custom reason`, async () => {
    const controller = new AbortController();
    const reason = new Error('Parent deadline exceeded');
    let requests = 0;
    await withMockFetch(async (input) => {
      requests++;
      const url = String(input);
      if (url.includes('/watch')) return new Response(FAKE_WATCH_PAGE);
      if (url.includes('/player') && outcome === 'empty-caption') return new Response(captionPlayer());
      controller.abort(reason);
      if (outcome === 'network-error') throw new TypeError('Connection closed');
      return new Response('', { status: outcome === 'rate-limit' ? 429 : 200 });
    }, async () => {
      await assert.rejects(fetchYouTubeTranscript('video123', 'es', 60, controller.signal), error => error === reason);
      assert.equal(requests, outcome === 'empty-caption' ? 3 : 2);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  });
}

test('fetchYouTubeTranscript returns transcript when Android client succeeds', async () => {
  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      // Page scrape request
      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      // InnerTube player request — return caption tracks
      if (url.includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/en',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
                {
                  baseUrl: 'https://captions.test/fr',
                  languageCode: 'fr',
                  name: { simpleText: 'Francais' },
                  kind: 'asr',
                },
              ],
            },
          },
        }));
      }

      // Caption track fetch — return XML with <p> format (milliseconds)
      if (url.startsWith('https://captions.test/en')) {
        return new Response(`<?xml version="1.0"?><timedtext><body>
          <p t="420" d="4200">hello &amp; welcome</p>
          <p t="5100" d="1500">&#39;quoted&#39;</p>
        </body></timedtext>`);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123');

      assert.ok(result, 'Should return a result');
      assert.equal(result.language, 'en');
      assert.deepEqual(result.availableLanguages, ['en', 'fr']);
      assert.equal(result.segments.length, 2);
      assert.equal(result.segments[0].text, 'hello & welcome');
      assert.equal(result.segments[0].start, 0.42);
      assert.equal(result.segments[0].duration, 4.2);
      assert.equal(result.segments[1].text, "'quoted'");
    }
  );
});

test('fetchYouTubeTranscript prefers requested language', async () => {
  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      if (url.includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/en',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
                {
                  baseUrl: 'https://captions.test/fr',
                  languageCode: 'fr',
                  name: { simpleText: 'Francais' },
                },
              ],
            },
          },
        }));
      }

      // Should request French since we asked for it
      if (url.startsWith('https://captions.test/fr')) {
        return new Response(`<?xml version="1.0"?><timedtext><body>
          <p t="0" d="1000">bonjour</p>
        </body></timedtext>`);
      }

      if (url.startsWith('https://captions.test/en')) {
        return new Response(`<?xml version="1.0"?><timedtext><body>
          <p t="0" d="1000">hello</p>
        </body></timedtext>`);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123', 'fr');

      assert.ok(result);
      assert.equal(result.language, 'fr');
      assert.equal(result.segments[0].text, 'bonjour');
    }
  );
});

test('fetchYouTubeTranscript returns null when video has no captions', async () => {
  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      if (url.includes('/youtubei/v1/player')) {
        // No captions object at all
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
        }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123');
      assert.equal(result, null);
    }
  );
});

test('fetchYouTubeTranscript tries next client when one is rate-limited', async () => {
  let innerTubeCallCount = 0;

  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      if (url.includes('/youtubei/v1/player')) {
        innerTubeCallCount++;
        // First call (Android) returns 429 rate limit
        if (innerTubeCallCount === 1) {
          return new Response('Too Many Requests', { status: 429 });
        }
        // Second call (Web) succeeds
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/en',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
              ],
            },
          },
        }));
      }

      if (url.startsWith('https://captions.test/en')) {
        return new Response(`<?xml version="1.0"?><timedtext><body>
          <p t="0" d="1000">hello from fallback</p>
        </body></timedtext>`);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123');

      assert.ok(result, 'Should succeed via fallback client');
      assert.equal(result.segments[0].text, 'hello from fallback');
      // Should have tried at least 2 InnerTube calls (Android failed, Web succeeded)
      assert.ok(innerTubeCallCount >= 2, `Expected >= 2 InnerTube calls, got ${innerTubeCallCount}`);
    }
  );
});

test('fetchYouTubeTranscript parses legacy <text> XML format', async () => {
  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      if (url.includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/en',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
              ],
            },
          },
        }));
      }

      // Return legacy XML format (seconds, <text> tags)
      if (url.startsWith('https://captions.test/en')) {
        return new Response(`<?xml version="1.0"?>
          <transcript>
            <text start="0.42" dur="4.2">hello &amp; welcome</text>
            <text start="5.1" dur="1.5">goodbye</text>
          </transcript>`);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123');

      assert.ok(result);
      assert.equal(result.segments.length, 2);
      assert.equal(result.segments[0].text, 'hello & welcome');
      assert.equal(result.segments[0].start, 0.42);
      assert.equal(result.segments[0].duration, 4.2);
    }
  );
});
