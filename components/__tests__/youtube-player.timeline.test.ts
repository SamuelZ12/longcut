import test from 'node:test';
import assert from 'node:assert/strict';

import { getYouTubePlayerVars, shouldRenderHighlightTimeline } from '@/components/youtube-player';

test('shouldRenderHighlightTimeline hides the custom bar until reels exist', () => {
  assert.equal(shouldRenderHighlightTimeline(300, 0), false);
  assert.equal(shouldRenderHighlightTimeline(0, 3), false);
  assert.equal(shouldRenderHighlightTimeline(300, 3), true);
});

test('getYouTubePlayerVars includes origin when available', () => {
  assert.deepEqual(getYouTubePlayerVars('http://localhost:3001'), {
    autoplay: 0,
    controls: 1,
    modestbranding: 1,
    rel: 0,
    origin: 'http://localhost:3001',
  });
});
