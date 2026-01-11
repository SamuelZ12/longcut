import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import {
  canStartTranscription,
  createTranscriptionJob,
  getActiveTranscriptionJob,
  getCompletedTranscription,
} from '@/lib/transcription-manager';
import { estimateCostCents, estimateProcessingTime } from '@/lib/gemini-transcription-client';

/**
 * POST /api/transcribe
 *
 * Initiates a new AI transcription job for a YouTube video.
 * Requires Pro subscription.
 *
 * Request body:
 * {
 *   youtubeId: string,       // YouTube video ID
 *   durationSeconds: number, // Video duration in seconds
 *   videoId?: string         // Optional: video_analyses ID if already saved
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   jobId?: string,
 *   status?: 'pending' | 'existing' | 'completed',
 *   estimatedWaitSeconds?: number,
 *   transcriptData?: object,  // If completed transcription exists
 *   error?: string,
 *   reason?: string
 * }
 */
async function handler(request: NextRequest) {
  try {
    const supabase = await createClient();

    // Check authentication
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        {
          success: false,
          error: 'Authentication required',
          reason: 'AUTH_REQUIRED',
        },
        { status: 401 }
      );
    }

    // Parse request body
    const body = await request.json();
    const { youtubeId, durationSeconds, videoId } = body;

    if (!youtubeId) {
      return NextResponse.json(
        {
          success: false,
          error: 'YouTube video ID is required',
          reason: 'MISSING_VIDEO_ID',
        },
        { status: 400 }
      );
    }

    if (!durationSeconds || typeof durationSeconds !== 'number' || durationSeconds <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Valid video duration is required',
          reason: 'MISSING_DURATION',
        },
        { status: 400 }
      );
    }

    // Check for existing completed transcription
    const completedJob = await getCompletedTranscription(youtubeId, {
      client: supabase,
    });

    if (completedJob?.transcriptData) {
      return NextResponse.json({
        success: true,
        status: 'completed',
        jobId: completedJob.id,
        transcriptData: completedJob.transcriptData,
      });
    }

    // Check for existing active job
    const activeJob = await getActiveTranscriptionJob(user.id, youtubeId, {
      client: supabase,
    });

    if (activeJob) {
      return NextResponse.json({
        success: true,
        status: 'existing',
        jobId: activeJob.id,
        progress: activeJob.progress,
        currentStage: activeJob.currentStage,
        estimatedWaitSeconds: estimateProcessingTime(durationSeconds),
      });
    }

    // Calculate estimated minutes (round up to nearest minute)
    const estimatedMinutes = Math.ceil(durationSeconds / 60);

    // Check if user can start transcription
    const decision = await canStartTranscription(
      user.id,
      youtubeId,
      estimatedMinutes,
      { client: supabase, user }
    );

    if (!decision.allowed) {
      const responseData: Record<string, unknown> = {
        success: false,
        reason: decision.reason,
        minutesNeeded: estimatedMinutes,
      };

      if (decision.stats) {
        responseData.usage = {
          subscriptionMinutes: decision.stats.subscriptionMinutes,
          topupMinutes: decision.stats.topupMinutes,
          totalRemaining: decision.stats.totalRemaining,
          resetAt: decision.stats.resetAt,
        };
      }

      switch (decision.reason) {
        case 'NOT_PRO':
          responseData.error = 'AI Transcription requires a Pro subscription';
          break;
        case 'INSUFFICIENT_CREDITS':
          responseData.error = 'Insufficient transcription minutes';
          responseData.requiresTopup = true;
          break;
        case 'EXISTING_JOB':
          responseData.error = 'A transcription job is already in progress';
          responseData.existingJobId = decision.existingJobId;
          break;
        default:
          responseData.error = 'Cannot start transcription';
      }

      return NextResponse.json(responseData, { status: 403 });
    }

    // Create the transcription job
    const estimatedCost = estimateCostCents(durationSeconds);

    const createResult = await createTranscriptionJob(user.id, youtubeId, {
      client: supabase,
      videoId: videoId || undefined,
      durationSeconds,
      estimatedCostCents: estimatedCost,
    });

    if (!createResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to create transcription job',
          reason: createResult.error,
        },
        { status: 500 }
      );
    }

    // Trigger background processing (fire and forget)
    // Get the origin from the request headers
    const origin = request.headers.get('origin') ||
      request.headers.get('referer')?.replace(/\/[^/]*$/, '') ||
      process.env.NEXT_PUBLIC_APP_URL ||
      'http://localhost:3000';

    fetch(`${origin}/api/transcribe/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: createResult.jobId }),
    }).catch((err) => {
      console.error('Failed to trigger transcription processing:', err);
    });

    // Return success with job details
    return NextResponse.json({
      success: true,
      status: 'pending',
      jobId: createResult.jobId,
      estimatedMinutes,
      estimatedWaitSeconds: estimateProcessingTime(durationSeconds),
      estimatedCostCents: estimatedCost,
      usage: decision.stats
        ? {
            subscriptionMinutes: decision.stats.subscriptionMinutes,
            topupMinutes: decision.stats.topupMinutes,
            totalRemaining: decision.stats.totalRemaining - estimatedMinutes,
          }
        : undefined,
      willUseTopup: decision.willUseTopup,
    });
  } catch (error) {
    console.error('Error initiating transcription:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'An error occurred while initiating transcription',
      },
      { status: 500 }
    );
  }
}

export const POST = withSecurity(handler, SECURITY_PRESETS.AUTHENTICATED);
