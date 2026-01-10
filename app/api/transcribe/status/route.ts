import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { getTranscriptionJob } from '@/lib/transcription-manager';

/**
 * GET /api/transcribe/status?jobId=xxx
 *
 * Polls the status of a transcription job.
 *
 * Query params:
 * - jobId: string (required) - The transcription job ID
 *
 * Response:
 * {
 *   success: boolean,
 *   status: 'pending' | 'downloading' | 'transcribing' | 'completed' | 'failed' | 'cancelled',
 *   progress: number (0-100),
 *   currentStage?: string,
 *   transcriptData?: object,  // Only when status is 'completed'
 *   error?: string,
 *   errorMessage?: string     // Job-specific error message
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
        },
        { status: 401 }
      );
    }

    // Get job ID from query params
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json(
        {
          success: false,
          error: 'Job ID is required',
        },
        { status: 400 }
      );
    }

    // Get the job
    const job = await getTranscriptionJob(jobId, { client: supabase });

    if (!job) {
      return NextResponse.json(
        {
          success: false,
          error: 'Transcription job not found',
        },
        { status: 404 }
      );
    }

    // Verify ownership
    if (job.userId !== user.id) {
      return NextResponse.json(
        {
          success: false,
          error: 'Access denied',
        },
        { status: 403 }
      );
    }

    // Build response based on status
    const response: Record<string, unknown> = {
      success: true,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      youtubeId: job.youtubeId,
    };

    // Add stage info for in-progress jobs
    if (['pending', 'downloading', 'transcribing'].includes(job.status)) {
      response.currentStage = job.currentStage || getDefaultStage(job.status);

      // Add chunk progress for long videos
      if (job.totalChunks > 1) {
        response.totalChunks = job.totalChunks;
        response.completedChunks = job.completedChunks;
      }
    }

    // Add transcript data for completed jobs
    if (job.status === 'completed' && job.transcriptData) {
      response.transcriptData = job.transcriptData;
      response.completedAt = job.completedAt?.toISOString();
    }

    // Add error info for failed jobs
    if (job.status === 'failed') {
      response.errorMessage = job.errorMessage || 'Transcription failed';
    }

    // Add timing info
    if (job.durationSeconds) {
      response.durationSeconds = job.durationSeconds;
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error getting transcription status:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'An error occurred while getting transcription status',
      },
      { status: 500 }
    );
  }
}

function getDefaultStage(status: string): string {
  switch (status) {
    case 'pending':
      return 'Queued for processing';
    case 'downloading':
      return 'Downloading audio';
    case 'transcribing':
      return 'Transcribing audio';
    default:
      return 'Processing';
  }
}

export const GET = withSecurity(handler, SECURITY_PRESETS.AUTHENTICATED);
