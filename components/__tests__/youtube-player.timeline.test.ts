import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  canExecutePlaybackCommand,
  getYouTubePlayerElementId,
  getYouTubePlayerVars,
  seekPlayerTo,
  shouldPollPlayerTime,
  shouldQueuePlaybackCommand,
  shouldRenderHighlightTimeline,
} from '@/components/youtube-player';
import { normalizeDensityBuckets } from '@/components/video-progress-bar';

const youtubePlayerSource = readFileSync(
  join(process.cwd(), 'components/youtube-player.tsx'),
  'utf8'
);

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

test('getYouTubePlayerElementId scopes the iframe container to the video', () => {
  assert.equal(getYouTubePlayerElementId('abc123'), 'youtube-player-abc123');
  assert.equal(getYouTubePlayerElementId('video_with_symbols'), 'youtube-player-video_with_symbols');
});

test('canExecutePlaybackCommand waits for player readiness', () => {
  assert.equal(canExecutePlaybackCommand(null, false, { type: 'SEEK', time: 10 }), false);
  assert.equal(canExecutePlaybackCommand({ seekTo: () => {} }, false, { type: 'SEEK', time: 10 }), false);
  assert.equal(canExecutePlaybackCommand({ playVideo: () => {} }, true, { type: 'SEEK', time: 10 }), false);
  assert.equal(canExecutePlaybackCommand({ seekTo: () => {} }, true, { type: 'SEEK', time: 10 }), true);
  assert.equal(canExecutePlaybackCommand({ playVideo: () => {} }, true, { type: 'PLAY' }), true);
});

test('shouldPollPlayerTime waits for a ready player time API', () => {
  assert.equal(shouldPollPlayerTime(null, false), false);
  assert.equal(shouldPollPlayerTime({ getCurrentTime: () => 12 }, false), false);
  assert.equal(shouldPollPlayerTime({ seekTo: () => {} }, true), false);
  assert.equal(shouldPollPlayerTime({ getCurrentTime: () => 12 }, true), true);
});

test('shouldQueuePlaybackCommand keeps commands until player is ready', () => {
  assert.equal(shouldQueuePlaybackCommand(null, false, null), false);
  assert.equal(shouldQueuePlaybackCommand({ type: 'SEEK', time: 25 }, false, null), true);
  assert.equal(shouldQueuePlaybackCommand({ type: 'SEEK', time: 25 }, false, { seekTo: () => {} }), true);
  assert.equal(shouldQueuePlaybackCommand({ type: 'SEEK', time: 25 }, true, { playVideo: () => {} }), true);
  assert.equal(shouldQueuePlaybackCommand({ type: 'SEEK', time: 25 }, true, { seekTo: () => {} }), false);
});

test('seekPlayerTo reports whether direct seeking was available', () => {
  const calls: Array<[number, boolean]> = [];
  const syncCalls: number[] = [];
  const player = {
    seekTo: (time: number, allowSeekAhead: boolean) => calls.push([time, allowSeekAhead]),
    playVideo: () => {},
  };

  assert.equal(seekPlayerTo(null, false, 15, (time) => syncCalls.push(time)), false);
  assert.equal(seekPlayerTo({ playVideo: () => {} }, true, 15, (time) => syncCalls.push(time)), false);
  assert.equal(seekPlayerTo(player, true, 42, (time) => syncCalls.push(time)), true);
  assert.deepEqual(calls, [[42, true]]);
  assert.deepEqual(syncCalls, [42]);
});

test('youtube player stores iframe readiness in a ref for direct seeking', () => {
  assert.match(youtubePlayerSource, /const playerReadyRef = useRef\(false\)/);
  assert.match(youtubePlayerSource, /playerReadyRef\.current = true/);
  assert.match(youtubePlayerSource, /playerReadyRef\.current = false/);
  assert.match(youtubePlayerSource, /seekPlayerTo\(playerRef\.current, playerReadyRef\.current, time, syncSeekTime\)/);
});

test('youtube player stores the constructed iframe player before onReady', () => {
  assert.match(youtubePlayerSource, /const nextPlayer = new \(window as any\)\.YT\.Player/);
  assert.match(youtubePlayerSource, /playerRef\.current = nextPlayer/);
});

test('youtube player replays a queued command when iframe readiness fires', () => {
  const readyHandlerStart = youtubePlayerSource.indexOf('onReady:');
  assert.notEqual(readyHandlerStart, -1, 'Expected YouTube onReady handler to exist');

  const readyHandlerSource = youtubePlayerSource.slice(readyHandlerStart, readyHandlerStart + 1200);
  assert.match(readyHandlerSource, /pendingPlaybackCommandRef\.current/);
  assert.match(readyHandlerSource, /executePlaybackCommandRef\.current/);
  assert.match(readyHandlerSource, /onCommandExecuted\?\.\(\)/);
});

test('normalizeDensityBuckets handles zero-density timelines', () => {
  assert.deepEqual(normalizeDensityBuckets([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(normalizeDensityBuckets([0, 2, 4]), [0, 0.5, 1]);
});
