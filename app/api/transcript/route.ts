import { NextRequest, NextResponse } from 'next/server';
import { extractVideoId } from '@/lib/utils';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { shouldUseMockData, getMockTranscript } from '@/lib/mock-data';
import { mergeTranscriptSegmentsIntoSentences } from '@/lib/transcript-sentence-merger';
import { NO_CREDITS_USED_MESSAGE } from '@/lib/no-credits-message';
import { fetchYouTubeTranscript } from '@/lib/youtube-transcript-provider';
import { fetchSupadataTranscript } from '@/lib/supadata-transcript-provider';
import { transcriptEligibility, reserveTranscriptSpend, transitionTranscriptSpend } from '@/lib/transcript-spend';
import { setGuestCookies } from '@/lib/guest-usage';
import { DependencyUnavailableError } from '@/lib/dependency-unavailable';

function respondWithNoCredits(
  payload: Record<string, unknown>,
  status: number,
  requestId: string
) {
  return NextResponse.json(
    {
      ...payload,
      requestId,
      creditsMessage: NO_CREDITS_USED_MESSAGE,
      creditsScope: 'longcut_allowance',
      noCreditsUsed: true
    },
    { status, headers: { 'x-request-id': requestId, 'Cache-Control': 'no-store',
      ...(typeof payload.retryAfter === 'number' ? { 'Retry-After': String(payload.retryAfter) } : {}) } }
  );
}

// Calculate transcript duration from segments
function calculateTranscriptDuration(segments: { start: number; duration: number }[]): number {
  if (segments.length === 0) return 0;
  const lastSegment = segments[segments.length - 1];
  return lastSegment.start + lastSegment.duration;
}

async function handler(request: NextRequest) {
  const requestId = crypto.randomUUID();
  try {
    const { url, lang: requestedLang, expectedDuration } = await request.json();
    if (typeof url !== 'string' || (requestedLang !== undefined &&
      (typeof requestedLang !== 'string' || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(requestedLang)))) {
      return respondWithNoCredits({ error: 'Invalid transcript request' }, 400, requestId);
    }
    const lang: string | undefined = requestedLang;

    if (!url) {
      return respondWithNoCredits({ error: 'YouTube URL is required' }, 400, requestId);
    }

    const videoId = extractVideoId(url);

    if (!videoId) {
      return respondWithNoCredits({ error: 'Invalid YouTube URL' }, 400, requestId);
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

    const eligibility = await transcriptEligibility();
    const respond = (payload: Record<string, unknown>, status: number) => {
      const response = respondWithNoCredits(payload, status, requestId);
      if (eligibility.guest) setGuestCookies(response, eligibility.guest);
      return response;
    };
    if (!eligibility.allowed) {
      return respond({ code: 'TRANSCRIPT_ELIGIBILITY_REQUIRED', reason: eligibility.reason,
        requiresAuth: eligibility.requiresAuth,
        error: eligibility.requiresAuth ? 'Sign in to request another fresh transcript.'
          : 'Your current video allowance or subscription does not permit fresh processing. Transcript requests do not spend a video credit.',
      }, eligibility.requiresAuth ? 401 : 403);
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
        source = 'supadata';
        const admission = await reserveTranscriptSpend(eligibility, videoId, lang);
        if (!admission.allowed) {
          if (admission.reason === 'guest_used') return respond({ code: 'TRANSCRIPT_ELIGIBILITY_REQUIRED',
            requiresAuth: true, error: 'Sign in to request another fresh transcript.' }, 401);
          const retryAfter = Math.max(1, Math.ceil((Date.parse(admission.resetAt) - Date.now()) / 1000));
          return respond({ code: 'TRANSCRIPT_SPEND_THROTTLED', reason: admission.reason,
            error: admission.reason === 'cooldown' ? 'A transcript request may still be processing. Please wait before retrying.'
              : 'Fresh transcript requests are temporarily limited. Cached videos remain available.',
            resetAt: admission.resetAt, retryAfter, retryable: true,
          }, 429);
        }
        if (request.signal.aborted) {
          await transitionTranscriptSpend(admission.reservationId, 'release');
          return respond({ code: 'TRANSCRIPT_DEPENDENCY_FAILURE', error: 'Transcript request cancelled before dispatch.' }, 503);
        }
        // Commit possible dispatch BEFORE invoking the provider. No refund after this boundary.
        await transitionTranscriptSpend(admission.reservationId, 'dispatch');
        const result = await fetchSupadataTranscript({ videoId, lang, apiKey: supadataKey, requestId, signal: request.signal });
        await transitionTranscriptSpend(admission.reservationId,
          result.outcome === 'unknown_upstream_acceptance' ? 'uncertain' : 'complete');
        if (result.outcome !== 'success') {
          const error = result.outcome === 'unavailable'
            ? 'No existing captions are available for this video.'
            : result.reason === 'unexpected_job'
              ? 'The transcript provider unexpectedly accepted background work. No transcript is available; Longcut will not automatically resubmit this request.'
              : result.outcome === 'unknown_upstream_acceptance'
                ? 'The transcript request did not complete. The provider may have accepted work; Longcut will not automatically resubmit this request.'
                : 'The transcript provider could not return usable captions.';
          return respond({
            error, code: `TRANSCRIPT_${result.outcome.toUpperCase()}`, outcome: result.outcome,
            reason: result.reason, source, retryable: false,
          }, result.outcome === 'unavailable' ? 404 : result.reason === 'timeout' ? 504 : 502);
        }
        rawSegments = result.segments;
        language = result.language;
        availableLanguages = result.availableLanguages;
      } else {
        console.warn(`[TRANSCRIPT] YouTube direct failed and no SUPADATA_API_KEY configured`);
      }
    }

    // ── Both methods failed ──
    if (!rawSegments || rawSegments.length === 0) {
      return respondWithNoCredits(
        { error: 'The transcript service is unavailable. Existing captions could not be checked.',
          code: 'TRANSCRIPT_DEPENDENCY_FAILURE', outcome: 'dependency_failure' },
        502,
        requestId
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

    const response = NextResponse.json({
      videoId,
      requestId,
      source,
      outcome: 'success',
      transcript: transformedTranscript,
      language,
      availableLanguages,
      // Transcript metadata for debugging and completeness validation
      transcriptDuration: Math.round(transcriptDuration),
      segmentCount: transformedTranscript.length,
      rawSegmentCount: rawSegments.length,
      isPartial,
      coverageRatio: coverageRatio ? Math.round(coverageRatio * 100) : undefined
    }, { headers: { 'x-request-id': requestId } });
    if (eligibility.guest) setGuestCookies(response, eligibility.guest);
    return response;
  } catch (error) {
    if (error instanceof DependencyUnavailableError) throw error;
    console.error('[TRANSCRIPT] Error processing transcript:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      type: error?.constructor?.name
    });
    return respondWithNoCredits({ error: 'Failed to fetch transcript' }, 500, requestId);
  }
}

export const POST = withSecurity(handler, SECURITY_PRESETS.PAID);
