import { NextRequest, NextResponse } from 'next/server';
import { extractVideoId } from '@/lib/utils';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { shouldUseMockData, getMockTranscript } from '@/lib/mock-data';
import { mergeTranscriptSegmentsIntoSentences } from '@/lib/transcript-sentence-merger';
import { NO_CREDITS_USED_MESSAGE } from '@/lib/no-credits-message';
import { z } from 'zod';

// Strict validation for language code (ISO 639-1)
// Only allow 2-10 alphanumeric characters and dashes
const langSchema = z.string()
  .min(2)
  .max(10)
  .regex(/^[a-zA-Z0-9-]+$/)
  .optional();

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

async function handler(request: NextRequest) {
  try {
    const { url, lang } = await request.json();

    if (!url) {
      return respondWithNoCredits({ error: 'YouTube URL is required' }, 400);
    }

    const videoId = extractVideoId(url);

    if (!videoId) {
      return respondWithNoCredits({ error: 'Invalid YouTube URL' }, 400);
    }

    // Validate lang if provided
    try {
      langSchema.parse(lang);
    } catch {
      return respondWithNoCredits({ error: 'Invalid language code format' }, 400);
    }

    if (shouldUseMockData()) {
      console.log(
        '[TRANSCRIPT] Using mock data (NEXT_PUBLIC_USE_MOCK_DATA=true)'
      );
      const mockData = getMockTranscript(videoId);

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

      return NextResponse.json({
        videoId,
        transcript: transformedTranscript,
        language: mockData.lang || 'en',
        availableLanguages: mockData.availableLangs || ['en']
      });
    }

    const apiKey = process.env.SUPADATA_API_KEY;
    if (!apiKey) {
      return respondWithNoCredits({ error: 'API configuration error' }, 500);
    }

    let transcriptSegments: any[] | null = null;
    let language: string | undefined;
    let availableLanguages: string[] | undefined;

    try {
      const apiUrl = new URL('https://api.supadata.ai/v1/transcript');
      apiUrl.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`);
      if (lang) {
        apiUrl.searchParams.set('lang', lang);
      } else {
        // Default to English if not specified, but this might need revisiting if we want auto-detection without preference
        // Supadata defaults to 'en' if not specified anyway, or auto-detects.
        // If we want auto-detect, we should probably not send lang unless the user picked one.
        // However, the original code hardcoded `&lang=en`.
        // To support "Any language", we can omit it, OR set it to the requested one.
        // For backward compatibility/consistency, maybe default to 'en' only if absolutely needed,
        // but removing it allows Supadata to return whatever is native.
        // BUT, Supadata docs say "lang: Preferred language code... If video does not have transcript in preferred language, endpoint will return transcript in first available language".
        // So passing 'en' is safe as a default preference.
        apiUrl.searchParams.set('lang', 'en');
      }

      const response = await fetch(
        apiUrl.toString(),
        {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      const responseText = await response.text();

      let parsedBody: Record<string, unknown> | null = null;

      if (responseText) {
        try {
          parsedBody = JSON.parse(responseText);
        } catch {
          parsedBody = null;
        }
      }

      const combinedErrorFields = [
        typeof parsedBody?.error === 'string' ? parsedBody.error : null,
        typeof parsedBody?.message === 'string' ? parsedBody.message : null,
        typeof parsedBody?.details === 'string' ? parsedBody.details : null,
        responseText || null
      ].filter(Boolean) as string[];

      const hasSupadataError =
        typeof parsedBody?.error === 'string' &&
        parsedBody.error.trim().length > 0;

      const supadataStatusMessage =
        typeof parsedBody?.message === 'string' &&
          parsedBody.message.trim().length > 0
          ? parsedBody.message.trim()
          : 'Transcript Unavailable';

      const supadataDetails =
        typeof parsedBody?.details === 'string' &&
          parsedBody.details.trim().length > 0
          ? parsedBody.details.trim()
          : 'No transcript is available for this video.';

      if (!response.ok) {
        if (response.status === 404) {
          return respondWithNoCredits(
            {
              error:
                'No transcript/captions available for this video. The video may not have subtitles enabled.'
            },
            404
          );
        }

        throw new Error(
          `Supadata transcript request failed (${response.status})${combinedErrorFields.length > 0
            ? `: ${combinedErrorFields.join(' ')}`
            : ''
          }`
        );
      }

      if (response.status === 206 || hasSupadataError) {
        return respondWithNoCredits(
          {
            error: supadataStatusMessage,
            details: supadataDetails
          },
          404
        );
      }

      const candidateContent = Array.isArray(parsedBody?.content)
        ? parsedBody?.content
        : Array.isArray(parsedBody?.transcript)
          ? parsedBody?.transcript
          : Array.isArray(parsedBody)
            ? parsedBody
            : null;

      if (!candidateContent || candidateContent.length === 0) {
        return respondWithNoCredits(
          {
            error: supadataStatusMessage,
            details: supadataDetails
          },
          404
        );
      }

      transcriptSegments = candidateContent;
      language = typeof parsedBody?.lang === 'string' ? parsedBody.lang : undefined;
      availableLanguages = Array.isArray(parsedBody?.availableLangs)
        ? parsedBody.availableLangs.filter((l): l is string => typeof l === 'string')
        : undefined;

    } catch (fetchError) {
      const errorMessage =
        fetchError instanceof Error ? fetchError.message : '';
      if (errorMessage.includes('404')) {
        return respondWithNoCredits(
          {
            error:
              'No transcript/captions available for this video. The video may not have subtitles enabled.'
          },
          404
        );
      }
      throw fetchError;
    }

    if (!transcriptSegments || transcriptSegments.length === 0) {
      return respondWithNoCredits(
        { error: 'No transcript available for this video' },
        404
      );
    }

    const rawSegments = Array.isArray(transcriptSegments)
      ? transcriptSegments.map((item) => {
        const transformed = {
          text: item.text || item.content || '',
          // Convert milliseconds to seconds for offset/start
          start:
            (item.offset !== undefined ? item.offset / 1000 : item.start) ||
            0,
          // Convert milliseconds to seconds for duration
          duration:
            (item.duration !== undefined ? item.duration / 1000 : 0) || 0
        };

        return transformed;
      })
      : [];

    // Merge segments into complete sentences for better translation
    const mergedSentences = mergeTranscriptSegmentsIntoSentences(rawSegments);
    const transformedTranscript = mergedSentences.map((sentence) => ({
      text: sentence.text,
      start: sentence.segments[0].start, // Use first segment's start time
      duration: sentence.segments.reduce((sum, seg) => sum + seg.duration, 0) // Sum all durations
    }));

    return NextResponse.json({
      videoId,
      transcript: transformedTranscript,
      language,
      availableLanguages
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
