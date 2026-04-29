import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { HighlightsPanel } from '@/components/highlights-panel';

const noop = () => {};

test('HighlightsPanel shows generate CTA instead of Play All before reels exist', () => {
  const markup = renderToStaticMarkup(
    <HighlightsPanel
      topics={[]}
      selectedTopic={null}
      onTopicSelect={noop}
      onSeek={noop}
      onPlayAll={noop}
      isPlayingAll={false}
      currentTime={0}
      videoDuration={120}
      onGenerateHighlights={noop}
    />
  );

  assert.match(markup, /Generate highlight reels/);
  assert.doesNotMatch(markup, />Play All</);
});

test('HighlightsPanel shows elapsed time while generating highlight reels', () => {
  const markup = renderToStaticMarkup(
    <HighlightsPanel
      topics={[]}
      selectedTopic={null}
      onTopicSelect={noop}
      onSeek={noop}
      onPlayAll={noop}
      isPlayingAll={false}
      currentTime={0}
      videoDuration={120}
      onGenerateHighlights={noop}
      isGeneratingHighlights
      highlightGenerationElapsedTime={19}
    />
  );

  assert.match(markup, /Analyzing video and generating highlight reels/);
  assert.match(markup, /Creating highlight reels\.\.\. \(19 seconds\)/);
});

test('HighlightsPanel keeps Play All controls when reels exist', () => {
  const markup = renderToStaticMarkup(
    <HighlightsPanel
      topics={[
        {
          id: 'topic-1',
          title: 'Useful section',
          description: 'A generated reel',
          duration: 30,
          segments: [{ start: 10, end: 40, text: 'Useful section text' }],
        },
      ]}
      selectedTopic={null}
      onTopicSelect={noop}
      onSeek={noop}
      onPlayAll={noop}
      isPlayingAll={false}
      currentTime={0}
      videoDuration={120}
      onGenerateHighlights={noop}
    />
  );

  assert.match(markup, />Play All</);
  assert.doesNotMatch(markup, /Generate highlight reels/);
});
