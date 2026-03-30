import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCaptionTrackCandidates,
  extractCaptionTracksFromWatchHtml,
  fetchYouTubeTranscript,
  transformCaptionJsonToSegments,
  transformCaptionXmlToSegments,
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

test('extractCaptionTracksFromWatchHtml returns caption tracks from player response', () => {
  const html = `
    <html>
      <body>
        <script>
          var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://example.com/en","languageCode":"en","name":{"simpleText":"English"}},{"baseUrl":"https://example.com/fr-auto","languageCode":"fr","name":{"simpleText":"Francais"},"kind":"asr"}]}}};
        </script>
      </body>
    </html>
  `;

  const tracks = extractCaptionTracksFromWatchHtml(html);

  assert.deepEqual(tracks, [
    {
      baseUrl: 'https://example.com/en',
      languageCode: 'en',
      kind: undefined,
      name: 'English',
    },
    {
      baseUrl: 'https://example.com/fr-auto',
      languageCode: 'fr',
      kind: 'asr',
      name: 'Francais',
    },
  ]);
});

test('buildCaptionTrackCandidates prioritizes requested language and manual tracks', () => {
  const tracks = [
    { baseUrl: 'https://example.com/en-auto', languageCode: 'en', kind: 'asr', name: 'English auto' },
    { baseUrl: 'https://example.com/fr-auto', languageCode: 'fr', kind: 'asr', name: 'Francais auto' },
    { baseUrl: 'https://example.com/fr', languageCode: 'fr', kind: undefined, name: 'Francais' },
    { baseUrl: 'https://example.com/de', languageCode: 'de', kind: undefined, name: 'Deutsch' },
  ];

  const candidates = buildCaptionTrackCandidates(tracks, 'fr');

  assert.deepEqual(
    candidates.map((track) => track.baseUrl),
    [
      'https://example.com/fr',
      'https://example.com/fr-auto',
      'https://example.com/en-auto',
      'https://example.com/de',
    ]
  );
});

test('transformCaptionJsonToSegments decodes entities and ignores empty events', () => {
  const segments = transformCaptionJsonToSegments({
    events: [
      {
        tStartMs: 1500,
        dDurationMs: 2500,
        segs: [{ utf8: 'Hello &amp; ' }, { utf8: 'welcome' }],
      },
      {
        tStartMs: 4000,
        dDurationMs: 1000,
      },
      {
        tStartMs: 5000,
        dDurationMs: 1250,
        segs: [{ utf8: '&#39;quoted&#39;' }],
      },
    ],
  });

  assert.deepEqual(segments, [
    {
      text: 'Hello & welcome',
      start: 1.5,
      duration: 2.5,
    },
    {
      text: "'quoted'",
      start: 5,
      duration: 1.25,
    },
  ]);
});

test('transformCaptionXmlToSegments parses youtube timedtext xml', () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0.42" dur="4.2">hello &amp; welcome</text><text start="5.1" dur="1.5">&#39;quoted&#39;</text></transcript>`;

  const segments = transformCaptionXmlToSegments(xml);

  assert.deepEqual(segments, [
    {
      text: 'hello & welcome',
      start: 0.42,
      duration: 4.2,
    },
    {
      text: "'quoted'",
      start: 5.1,
      duration: 1.5,
    },
  ]);
});

test('fetchYouTubeTranscript preserves an explicitly requested language', async () => {
  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/fr',
                  languageCode: 'fr',
                  name: { simpleText: 'Francais' },
                },
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

      if (url === 'https://captions.test/fr') {
        return new Response('<transcript><text start="0" dur="1">bonjour</text></transcript>');
      }

      if (url === 'https://captions.test/en') {
        return new Response('<transcript><text start="0" dur="800">hello</text></transcript>');
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123', 'fr', 1200);

      assert.equal(result?.language, 'fr');
      assert.deepEqual(result?.availableLanguages, ['fr', 'en']);
      assert.deepEqual(result?.segments, [
        {
          text: 'bonjour',
          start: 0,
          duration: 1,
        },
      ]);
    }
  );
});

test('fetchYouTubeTranscript throws when caption tracks exist but all fetches fail', async () => {
  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
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

      if (url === 'https://captions.test/en') {
        return new Response('', { status: 500 });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      await assert.rejects(() => fetchYouTubeTranscript('video123'));
    }
  );
});
