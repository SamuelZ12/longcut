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

    // ── Strategy: Try YouTube direct first (free), fall back to Supadata (paid) ──
    // YouTube's InnerTube API is free but gets blocked from datacenter IPs.
    // Supadata is a paid API that handles YouTube's bot detection for us.
    // By trying free first, we only pay for Supadata when YouTube blocks us.

    let rawSegments: { text: string; start: number; duration: number }[] | null = null;
    let language: string | undefined;
    let availableLanguages: string[] | undefined;
    let source: 'youtube-direct' | 'supadata' = 'youtube-direct';

    // ── Attempt 1: YouTube InnerTube API (free) ──
    console.log(`[TRANSCRIPT] Trying YouTube direct for ${videoId} (lang=${lang ?? 'auto'})`);
    try {
      const ytResult = await fetchYouTubeTranscript(videoId, lang, expectedDuration);
      if (ytResult && ytResult.segments.length > 0) {
        rawSegments = ytResult.segments;
        language = ytResult.language;
        availableLanguages = ytResult.availableLanguages;
        source = 'youtube-direct';
        console.log(`[TRANSCRIPT] YouTube direct succeeded: ${rawSegments.length} segments, lang=${language}`);
      }
    } catch (ytError) {
      console.warn(`[TRANSCRIPT] YouTube direct failed:`, ytError instanceof Error ? ytError.message : String(ytError));
    }

    // ── Attempt 2: Supadata API (paid fallback) ──
    if (!rawSegments || rawSegments.length === 0) {
      const supadataKey = process.env.SUPADATA_API_KEY;
      if (supadataKey) {
        console.log(`[TRANSCRIPT] Falling back to Supadata for ${videoId}`);
        source = 'supadata';
        try {
          const apiUrl = new URL('https://api.supadata.ai/v1/transcript');
          apiUrl.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`);
          if (lang) apiUrl.searchParams.set('lang', lang);

          const supadataResp = await fetch(apiUrl.toString(), {
            method: 'GET',
            headers: { 'x-api-key': supadataKey, 'Content-Type': 'application/json' },
          });

          if (supadataResp.ok) {
            const body = await supadataResp.json() as Record<string, unknown>;
            const content = Array.isArray(body?.content) ? body.content
              : Array.isArray(body?.transcript) ? body.transcript
              : Array.isArray(body) ? body : null;

            if (content && content.length > 0) {
              // Supadata returns timestamps in either ms or seconds — detect and normalize
              const sampleSize = Math.min(5, content.length);
              let totalOffset = 0;
              let offsetCount = 0;
              for (let i = 0; i < sampleSize; i++) {
                const val = content[i].offset ?? content[i].start ?? 0;
                if (val > 0) { totalOffset += val; offsetCount++; }
              }
              const isMs = offsetCount > 0 && (totalOffset / offsetCount) > 500;

              rawSegments = content.map((item: any) => ({
                text: (item.text || item.content || '').replace(/^>>\s*/gm, ''),
                start: isMs ? ((item.offset ?? item.start ?? 0) / 1000) : (item.offset ?? item.start ?? 0),
                duration: isMs ? ((item.duration ?? 0) / 1000) : (item.duration ?? 0),
              }));
              language = typeof body?.lang === 'string' ? body.lang : undefined;
              availableLanguages = Array.isArray(body?.availableLangs)
                ? (body.availableLangs as unknown[]).filter((l): l is string => typeof l === 'string')
                : undefined;
              console.log(`[TRANSCRIPT] Supadata fallback succeeded: ${rawSegments!.length} segments`);
            }
          } else {
            console.warn(`[TRANSCRIPT] Supadata returned ${supadataResp.status}`);
          }
        } catch (supErr) {
          console.error(`[TRANSCRIPT] Supadata fallback failed:`, supErr instanceof Error ? supErr.message : String(supErr));
        }
      } else {
        console.warn(`[TRANSCRIPT] YouTube direct failed and no SUPADATA_API_KEY configured`);
      }
    }

    // ── Both methods failed ──
    if (!rawSegments || rawSegments.length === 0) {
      return respondWithNoCredits(
        { error: 'No transcript available for this video. The video may not have subtitles enabled.' },
        404
      );
    }

    console.log(`[TRANSCRIPT] Using ${source} result:`, {
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
      source,
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
