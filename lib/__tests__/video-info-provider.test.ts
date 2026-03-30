import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchYouTubeVideoInfo } from '../video-info-provider';

test('fetchYouTubeVideoInfo returns oEmbed metadata when available', async () => {
  const result = await fetchYouTubeVideoInfo(
    'abc123xyz89',
    async () => new Response(JSON.stringify({
      title: 'Test Title',
      author_name: 'Channel Name',
      thumbnail_url: 'https://img.example.com/thumb.jpg',
    }))
  );

  assert.deepEqual(result, {
    videoId: 'abc123xyz89',
    title: 'Test Title',
    author: 'Channel Name',
    thumbnail: 'https://img.example.com/thumb.jpg',
    duration: 0,
  });
});

test('fetchYouTubeVideoInfo falls back to minimal metadata when oEmbed is not ok', async () => {
  const result = await fetchYouTubeVideoInfo(
    'abc123xyz89',
    async () => new Response('not found', { status: 404 })
  );

  assert.deepEqual(result, {
    videoId: 'abc123xyz89',
    title: 'YouTube Video',
    author: 'Unknown',
    thumbnail: 'https://img.youtube.com/vi/abc123xyz89/maxresdefault.jpg',
    duration: 0,
  });
});

test('fetchYouTubeVideoInfo falls back to minimal metadata when oEmbed throws', async () => {
  const result = await fetchYouTubeVideoInfo(
    'abc123xyz89',
    async () => {
      throw new Error('network failed');
    }
  );

  assert.deepEqual(result, {
    videoId: 'abc123xyz89',
    title: 'YouTube Video',
    author: 'Unknown',
    thumbnail: 'https://img.youtube.com/vi/abc123xyz89/maxresdefault.jpg',
    duration: 0,
  });
});
