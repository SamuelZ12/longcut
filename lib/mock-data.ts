/**
 * Mock video data for local development when external video fetching is unavailable
 * Enable by setting NEXT_PUBLIC_USE_MOCK_DATA=true in .env.local
 *
 * Note: This is separate from mock translation (TRANSLATION_PROVIDER='mock')
 * You can mix and match: use real video data with mock translation, or vice versa
 */

import transcriptData from '../resources/transcripts/example_1.json';
import videoInfoData from '../resources/videoInfo/example1.json';

// Use the imported transcript data
export const MOCK_TRANSCRIPT = transcriptData;

/**
 * Get mock video info for a given video ID
 */
export function getMockVideoInfo(videoId: string) {
  return {
    ...videoInfoData,
    id: videoId,
    videoId: videoId
  };
}

/**
 * Get mock transcript for a given video ID
 */
export function getMockTranscript() {
  return {
    content: MOCK_TRANSCRIPT,
    lang: 'en',
    availableLangs: ['en']
  };
}

/**
 * Check if mock data should be used
 */
export function shouldUseMockData(): boolean {
  return process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true';
}

export function shouldUseMockVideoInfo(): boolean {
  return process.env.NEXT_PUBLIC_USE_MOCK_VIDEO_INFO === 'true';
}
