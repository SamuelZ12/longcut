import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  videoAnalysisRequestSchema,
  formatValidationError
} from '@/lib/validation';
import { z } from 'zod';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import {
  generateTopicsFromTranscript,
  generateThemesFromTranscript
} from '@/lib/ai-processing';
import { hasUnlimitedVideoAllowance } from '@/lib/access-control';
import {
  canGenerateVideo,
  consumeVideoCreditAtomic,
  type GenerationDecision
} from '@/lib/subscription-manager';
import { NO_CREDITS_USED_MESSAGE } from '@/lib/no-credits-message';
import { ensureMergedFormat } from '@/lib/transcript-format-detector';
import { TranscriptSegment } from '@/lib/types';
import { getGuestAccessState, recordGuestUsage, setGuestCookies } from '@/lib/guest-usage';
import { saveVideoAnalysisWithRetry } from '@/lib/video-save-utils';

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

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

async function hasCountedGenerationThisPeriod({
  supabase,
  userId,
  youtubeId,
  videoId,
  periodStart,
  periodEnd
}: {
  supabase: SupabaseServerClient;
  userId: string;
  youtubeId: string;
  videoId?: string | null;
  periodStart: Date;
  periodEnd: Date;
}): Promise<boolean> {
  const orConditions = [`youtube_id.eq.${youtubeId}`];

  if (videoId) {
    orConditions.push(`video_id.eq.${videoId}`);
  }

  const { data, error } = await supabase
    .from('video_generations')
    .select('id')
    .eq('user_id', userId)
    .eq('counted_toward_limit', true)
    .gte('created_at', periodStart.toISOString())
    .lte('created_at', periodEnd.toISOString())
    .or(orConditions.join(','))
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Failed to check existing generation for cached video:', error);
    return false;
  }

  return Boolean(data);
}

async function handler(req: NextRequest) {
  try {
    // Parse and validate request body
    const body = await req.json();

    let validatedData;
    try {
      validatedData = videoAnalysisRequestSchema.parse(body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return respondWithNoCredits(
          {
            error: 'Validation failed',
            details: formatValidationError(error)
          },
          400
        );
      }
      throw error;
    }

    const {
      videoId,
      videoInfo,
      transcript,
      forceRegenerate,
      theme,
      mode
    } = validatedData;

    const supabase = await createClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();

    const guestState = user ? null : await getGuestAccessState({ supabase });
    const unlimitedAccess = hasUnlimitedVideoAllowance(user);

    let cachedVideo: any = null;
    if (!forceRegenerate) {
      const { data } = await supabase
        .from('video_analyses')
        .select('*')
        .eq('youtube_id', videoId)
        .single();

      cachedVideo = data ?? null;
    }

    // Check if we have valid cached topics (must be non-empty array)
    const isCachedAnalysis = Array.isArray(cachedVideo?.topics) && cachedVideo.topics.length > 0;

    let generationDecision: GenerationDecision | null = null;
    let alreadyCountedThisPeriod = false;

    if (theme) {
      // Guests only get one fresh analysis; allow themed queries for cached videos
      if (!user && guestState?.used && !isCachedAnalysis) {
        const response = respondWithNoCredits(
          {
            error: 'Sign in to analyze videos',
            message: 'You have used your free preview. Create a free account to keep analyzing videos.',
            requiresAuth: true,
            redirectTo: '/?auth=signup'
          },
          401
        );

        setGuestCookies(response, guestState);
        return response;
      }

      try {
        const { topics: themedTopics } = await generateTopicsFromTranscript(
          transcript,
          {
            videoInfo,
            theme,
            excludeTopicKeys: new Set(validatedData.excludeTopicKeys ?? []),
            includeCandidatePool: false,
            mode,
            language: videoInfo?.language
          }
        );

        // If no topics were generated for the theme, it means the AI couldn't find relevant content
        if (themedTopics.length === 0) {
          console.log(`[video-analysis] No content found for theme: "${theme}"`);
          return NextResponse.json({
            topics: [],
            theme,
            cached: false,
            topicCandidates: undefined,
            error: `No content found for theme: "${theme}"`
          });
        }

        const response = NextResponse.json({
          topics: themedTopics,
          theme,
          cached: false,
          topicCandidates: undefined
        });

        if (!user && guestState) {
          // Consume the one-time guest allowance only when this isn't a cached analysis
          const shouldConsumeGuest = !guestState.used && !isCachedAnalysis;
          if (shouldConsumeGuest) {
            await recordGuestUsage(guestState, { supabase });
          }
          setGuestCookies(response, guestState, {
            markUsed: shouldConsumeGuest
          });
        }

        return response;
      } catch (error) {
        console.error('Error generating theme-specific topics:', error);
        return respondWithNoCredits(
          { error: 'Failed to generate themed topics. Please try again.' },
          500
        );
      }
    }

    if (!user) {
      if (guestState?.used && !isCachedAnalysis) {
        const response = respondWithNoCredits(
          {
            error: 'Sign in to analyze videos',
            message: 'You have used your free preview. Create a free account for 3 videos/month or upgrade for more.',
            requiresAuth: true,
            redirectTo: '/?auth=signup'
          },
          401
        );

        if (guestState) {
          setGuestCookies(response, guestState);
        }

        return response;
      }
    } else if (!unlimitedAccess) {
      generationDecision = await canGenerateVideo(user.id, videoId, {
        client: supabase,
        skipCacheCheck: true
      });

      if (isCachedAnalysis && generationDecision.stats) {
        alreadyCountedThisPeriod = await hasCountedGenerationThisPeriod({
          supabase,
          userId: user.id,
          youtubeId: videoId,
          videoId: cachedVideo?.id ?? null,
          periodStart: generationDecision.stats.periodStart,
          periodEnd: generationDecision.stats.periodEnd
        });
      }

      if (!alreadyCountedThisPeriod && !generationDecision.allowed) {
        const tier = generationDecision.subscription?.tier ?? 'free';
        const stats = generationDecision.stats;
        const resetAt =
          stats?.resetAt ??
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

        let errorMessage = 'Monthly limit reached';
        let upgradeMessage =
          'You have reached your monthly quota. Upgrade your plan to continue.';
        let statusCode = 429;

        if (generationDecision.reason === 'SUBSCRIPTION_INACTIVE') {
          errorMessage = 'Subscription inactive';
          upgradeMessage =
            'Your subscription is not active. Visit the billing portal to reactivate and continue generating videos.';
          statusCode = 402;
        } else if (tier === 'free') {
          upgradeMessage =
            "You've used all 3 free videos this month. Upgrade to Pro for 100 videos/month ($9.99/mo).";
        } else if (tier === 'pro') {
          if (generationDecision.requiresTopupPurchase) {
            upgradeMessage =
              'You have used all Pro videos this period. Purchase a Top-Up (+20 videos for $2.99) or wait for your next billing cycle.';
          } else {
            upgradeMessage =
              'You have used your Pro allowance. Wait for your next billing cycle to reset.';
          }
        }

        return NextResponse.json(
          {
            error: errorMessage,
            message: upgradeMessage,
            code: generationDecision.reason,
            tier,
            limit: stats?.baseLimit ?? null,
            remaining: stats?.totalRemaining ?? 0,
            resetAt,
            isAuthenticated: true,
            warning: generationDecision.warning,
            requiresTopup: generationDecision.requiresTopupPurchase ?? false
          },
          {
            status: statusCode,
            headers: {
              'X-RateLimit-Remaining': String(
                Math.max(stats?.totalRemaining ?? 0, 0)
              ),
              'X-RateLimit-Reset': resetAt
            }
          }
        );
      }
    }

    // Serve cached analysis but still count credits when required
    if (!forceRegenerate && cachedVideo && cachedVideo.topics) {
      // If user is logged in, track their access to this video with retry logic
      if (user) {
        const saveResult = await saveVideoAnalysisWithRetry(supabase, {
          youtubeId: videoId,
          title: cachedVideo.title,
          author: cachedVideo.author,
          duration: cachedVideo.duration,
          thumbnailUrl: cachedVideo.thumbnail_url,
          transcript: cachedVideo.transcript,
          topics: cachedVideo.topics,
          summary: cachedVideo.summary || null,
          suggestedQuestions: cachedVideo.suggested_questions || null,
          modelUsed: cachedVideo.model_used,
          userId: user.id,
          language: cachedVideo.language || null,
          availableLanguages: cachedVideo.available_languages || null
        });

        if (!saveResult.success) {
          console.error(
            `[video-analysis] Failed to link cached video ${videoId} to user ${user.id}:`,
            saveResult.error
          );
        } else if (saveResult.retriedCount > 0) {
          console.log(
            `[video-analysis] Successfully saved cached video after ${saveResult.retriedCount} retries`
          );
        }
      }

      const shouldConsumeCachedCredit = Boolean(
        user &&
        !unlimitedAccess &&
        !alreadyCountedThisPeriod &&
        generationDecision?.subscription &&
        generationDecision.stats
      );

      if (shouldConsumeCachedCredit && user && generationDecision?.subscription && generationDecision.stats) {
        const consumeResult = await consumeVideoCreditAtomic({
          userId: user.id,
          youtubeId: videoId,
          subscription: generationDecision.subscription,
          statsSnapshot: generationDecision.stats,
          videoAnalysisId: cachedVideo.id,
          counted: true
        });

        if (!consumeResult.success) {
          console.error('Failed to consume cached video credit:', consumeResult.error);
        } else if (consumeResult.deduplicated) {
          console.log(`[video-analysis] Deduplicated credit for cached video ${videoId} (user: ${user.id})`);
        }
      }

      let themes: string[] = [];
      try {
        themes = await generateThemesFromTranscript(
          transcript,
          videoInfo,
          undefined,
          videoInfo?.language
        );
      } catch (error) {
        console.error('Error generating themes for cached video:', error);
      }

      // Ensure transcript is in merged format (backward compatibility for old cached videos)
      const originalTranscript = cachedVideo.transcript as TranscriptSegment[];
      const migratedTranscript = ensureMergedFormat(originalTranscript, {
        enableLogging: true,
        context: `YouTube ID: ${videoId}`
      });

      const response = NextResponse.json({
        topics: cachedVideo.topics,
        transcript: migratedTranscript,
        videoInfo: {
          title: cachedVideo.title,
          author: cachedVideo.author,
          duration: cachedVideo.duration,
          thumbnail: cachedVideo.thumbnail_url
        },
        summary: cachedVideo.summary,
        suggestedQuestions: cachedVideo.suggested_questions,
        themes,
        cached: true,
        cacheDate: cachedVideo.created_at
      });

      if (!user && guestState) {
        setGuestCookies(response, guestState);
      }

      return response;
    }

    const generationResult = await generateTopicsFromTranscript(
      transcript,
      {
        videoInfo,
        includeCandidatePool: validatedData.includeCandidatePool,
        excludeTopicKeys: new Set(validatedData.excludeTopicKeys ?? []),
        mode,
        language: videoInfo?.language
      }
    );
    const topics = generationResult.topics;
    const topicCandidates = generationResult.candidates;
    const modelUsed = generationResult.modelUsed;

    let themes: string[] = [];
    try {
      themes = await generateThemesFromTranscript(
        transcript,
        videoInfo,
        undefined,
        videoInfo?.language
      );
    } catch (error) {
      console.error('Error generating themes:', error);
    }

    // Save analysis to database FIRST (before consuming credit)
    // This ensures credits are only consumed if save succeeds
    const saveResult = await saveVideoAnalysisWithRetry(supabase, {
      youtubeId: videoId,
      title: videoInfo?.title || `YouTube Video ${videoId}`,
      author: videoInfo?.author || null,
      duration: videoInfo?.duration ?? 0,
      thumbnailUrl: videoInfo?.thumbnail || null,
      transcript: transcript,
      topics: topics,
      summary: null, // Summary generated separately via /api/generate-summary
      suggestedQuestions: null,
      modelUsed: modelUsed,
      userId: user?.id || null,
      language: videoInfo?.language || null,
      availableLanguages: videoInfo?.availableLanguages || null
    });

    if (!saveResult.success) {
      // Log but don't fail the request - user should still see their results
      console.error(
        `[video-analysis] Failed to save new video ${videoId}:`,
        saveResult.error
      );
    } else if (saveResult.retriedCount > 0) {
      console.log(
        `[video-analysis] Successfully saved new video after ${saveResult.retriedCount} retries`
      );
    }

    // Only consume credit AFTER successful save
    if (
      saveResult.success &&
      user &&
      !unlimitedAccess &&
      generationDecision?.subscription &&
      generationDecision.stats
    ) {
      const consumeResult = await consumeVideoCreditAtomic({
        userId: user.id,
        youtubeId: videoId,
        subscription: generationDecision.subscription,
        statsSnapshot: generationDecision.stats,
        videoAnalysisId: saveResult.videoId ?? undefined,
        counted: true
      });

      if (!consumeResult.success) {
        console.error('Failed to consume video credit:', consumeResult.error);
      } else if (consumeResult.deduplicated) {
        console.log(`[video-analysis] Deduplicated credit for new video ${videoId} (user: ${user.id})`);
      }
    }

    if (!user && guestState) {
      await recordGuestUsage(guestState, { supabase });
    }

    const response = NextResponse.json({
      topics,
      themes,
      cached: false,
      topicCandidates: validatedData.includeCandidatePool
        ? topicCandidates ?? []
        : undefined,
      modelUsed
    });

    if (!user && guestState) {
      setGuestCookies(response, guestState, { markUsed: true });
    }

    return response;
  } catch (error) {
    // Log error details server-side only
    console.error('Error in video analysis:', error);

    // Return generic error message to client
    return respondWithNoCredits(
      { error: 'An error occurred while processing your request' },
      500
    );
  }
}

export const POST = withSecurity(handler, SECURITY_PRESETS.PUBLIC);
