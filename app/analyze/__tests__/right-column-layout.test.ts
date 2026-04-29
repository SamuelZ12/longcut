import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const pageSource = readFileSync(
  join(process.cwd(), 'app/analyze/[videoId]/page.tsx'),
  'utf8'
);

test('right column height recalculates when transcript workspace becomes visible', () => {
  const effectStart = pageSource.indexOf('// Dynamically adjust right column height');
  assert.notEqual(effectStart, -1, 'Expected right-column height effect to exist');

  const effectSource = pageSource.slice(effectStart, effectStart + 1800);

  assert.match(effectSource, /requestAnimationFrame/);
  assert.match(effectSource, /transcript\.length/);
  assert.match(effectSource, /pageState/);
});

test('right column has a defensive minimum height before measurement completes', () => {
  const containerStart = pageSource.indexOf('id="right-column-container"');
  assert.notEqual(containerStart, -1, 'Expected right-column container to exist');

  const containerSource = pageSource.slice(containerStart, containerStart + 500);
  assert.match(containerSource, /minHeight:\s*420/);
});

test('youtube player remounts when the analyzed video changes', () => {
  const playerStart = pageSource.indexOf('<YouTubePlayer\n');
  assert.notEqual(playerStart, -1, 'Expected YouTubePlayer render to exist');

  const playerSource = pageSource.slice(playerStart, playerStart + 600);
  assert.match(playerSource, /key=\{videoId\}/);
});

test('transcript seeks try the current youtube player before queuing a command', () => {
  const requestSeekStart = pageSource.indexOf('const requestSeek = useCallback');
  assert.notEqual(requestSeekStart, -1, 'Expected requestSeek callback to exist');

  const requestSeekSource = pageSource.slice(requestSeekStart, requestSeekStart + 300);
  assert.match(requestSeekSource, /youtubePlayerRef\.current\?\.seekTo\(time\)/);
  assert.match(requestSeekSource, /setPlaybackCommand\(\{ type: 'SEEK', time \}\)/);
});
