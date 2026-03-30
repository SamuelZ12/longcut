import { NextRequest, NextResponse } from 'next/server';
import { extractVideoId } from '@/lib/utils';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { shouldUseMockData, getMockTranscript } from '@/lib/mock-data';
import { mergeTranscriptSegmentsIntoSentences } from '@/lib/transcript-sentence-merger';
import { NO_CREDITS_USED_MESSAGE } from '@/lib/no-credits-message';
import { fetchYouTubeTranscript } from '@/lib/youtube-transcript-provider';

function respondWithNoCredits(
  payload: Record<string, unknown>,
  status: number
) {
  return NextResponse.json(
    {
      ...payload,
      creditsMessage: NO_CREDITS_USED_MESSAGE,
      noCreditsUsed: true
    },
    { status }
  );
}

// Calculate transcript duration from segments
function calculateTranscriptDuration(segments: { start: number; duration: number }[]): number {
  if (segments.length === 0) return 0;
  const lastSegment = segments[segments.length - 1];
  return lastSegment.start + lastSegment.duration;
}

async function handler(request: NextRequest) {
  try {
    const { url, lang, expectedDuration } = await request.json();

    if (!url) {
      return respondWithNoCredits({ error: 'YouTube URL is required' }, 400);
    }

    const videoId = extractVideoId(url);

    if (!videoId) {
      return respondWithNoCredits({ error: 'Invalid YouTube URL' }, 400);
    }

    if (shouldUseMockData()) {
      console.log(
        '[TRANSCRIPT] Using mock data (NEXT_PUBLIC_USE_MOCK_DATA=true)'
      );
      const mockData = getMockTranscript();

      const rawSegments = mockData.content.map((item: any) => ({
        text: item.text,
        start: item.offset / 1000, // Convert milliseconds to seconds
        duration: item.duration / 1000 // Convert milliseconds to seconds
      }));

      // Merge segments into complete sentences for better translation
      const mergedSentences = mergeTranscriptSegmentsIntoSentences(rawSegments);
      const transformedTranscript = mergedSentences.map((sentence) => ({
        text: sentence.text,
        start: sentence.segments[0].start, // Use first segment's start time
        duration: sentence.segments.reduce((sum, seg) => sum + seg.duration, 0) // Sum all durations
      }));

      const transcriptDuration = rawSegments.length > 0
        ? rawSegments[rawSegments.length - 1].start + rawSegments[rawSegments.length - 1].duration
        : 0;

      return NextResponse.json({
        videoId,
        transcript: transformedTranscript,
        language: mockData.lang || 'en',
        availableLanguages: mockData.availableLangs || ['en'],
        transcriptDuration: Math.round(transcriptDuration),
        segmentCount: transformedTranscript.length,
        rawSegmentCount: rawSegments.length,
        isPartial: false,
        coverageRatio: undefined,
      });
    }

    console.log(`[TRANSCRIPT] Attempting free transcript fetch for ${videoId} with lang=${lang ?? 'auto-detect'}`);

    const transcriptResult = await fetchYouTubeTranscript(videoId, lang, expectedDuration);

    if (!transcriptResult || transcriptResult.segments.length === 0) {
      return respondWithNoCredits(
        { error: 'No transcript available for this video. The video may not have subtitles enabled.' },
        404
      );
    }

    const rawSegments = transcriptResult.segments;
    const language = transcriptResult.language;
    const availableLanguages = transcriptResult.availableLanguages;

    console.log('[TRANSCRIPT] Free transcript response:', {
      videoId,
      segmentCount: rawSegments.length,
      transcriptDuration: Math.round(calculateTranscriptDuration(rawSegments)),
      language,
      availableLanguages,
    });

    // Merge segments into complete sentences for better translation
    const mergedSentences = mergeTranscriptSegmentsIntoSentences(rawSegments);
    const transformedTranscript = mergedSentences.map((sentence) => ({
      text: sentence.text,
      start: sentence.segments[0].start, // Use first segment's start time
      duration: sentence.segments.reduce((sum, seg) => sum + seg.duration, 0) // Sum all durations
    }));

    // Calculate transcript duration (time covered by the transcript)
    const transcriptDuration = rawSegments.length > 0
      ? rawSegments[rawSegments.length - 1].start + rawSegments[rawSegments.length - 1].duration
      : 0;

    // Determine if transcript might be partial
    const coverageRatio = expectedDuration ? transcriptDuration / expectedDuration : null;
    const isPartial = expectedDuration
      ? transcriptDuration < expectedDuration * 0.5 // Less than 50% coverage
      : false;

    // Diagnostic logging: track processed transcript stats
    console.log('[TRANSCRIPT] Processed transcript:', {
      videoId,
      rawSegmentCount: rawSegments.length,
      mergedSegmentCount: transformedTranscript.length,
      transcriptDuration: Math.round(transcriptDuration),
      expectedDuration: expectedDuration ?? 'not provided',
      coverageRatio: coverageRatio ? `${Math.round(coverageRatio * 100)}%` : 'unknown',
      isPartial,
      firstSegmentStart: rawSegments[0]?.start,
      lastSegmentEnd: rawSegments.length > 0
        ? rawSegments[rawSegments.length - 1].start + rawSegments[rawSegments.length - 1].duration
        : 0
    });

    return NextResponse.json({
      videoId,
      transcript: transformedTranscript,
      language,
      availableLanguages,
      // Transcript metadata for debugging and completeness validation
      transcriptDuration: Math.round(transcriptDuration),
      segmentCount: transformedTranscript.length,
      rawSegmentCount: rawSegments.length,
      isPartial,
      coverageRatio: coverageRatio ? Math.round(coverageRatio * 100) : undefined
    });
  } catch (error) {
    console.error('[TRANSCRIPT] Error processing transcript:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      type: error?.constructor?.name
    });
    return respondWithNoCredits({ error: 'Failed to fetch transcript' }, 500);
  }
}

export const POST = withSecurity(handler, SECURITY_PRESETS.PUBLIC);
