import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import {
  getTranscriptionJob,
  updateTranscriptionJobStatus,
  consumeTranscriptionMinutes,
  refundTranscriptionMinutes,
} from '@/lib/transcription-manager';
import { extractYouTubeAudio, createAudioFile } from '@/lib/cobalt-client';
import { transcribeAudio } from '@/lib/gemini-transcription-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes max for Vercel Pro

/**
 * POST /api/transcribe/process
 *
 * Processes a pending transcription job.
 * This endpoint is called internally to process jobs in the background.
 *
 * Request body:
 * {
 *   jobId: string,
 *   internalKey?: string  // Optional: for verifying internal calls
 * }
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { jobId } = body;

    if (!jobId || typeof jobId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid jobId' },
        { status: 400 }
      );
    }

    console.log(`[Transcription] Starting processing for job ${jobId}`);

    const supabase = createServiceRoleClient();

    // Fetch the job
    const job = await getTranscriptionJob(jobId, { client: supabase });

    if (!job) {
      return NextResponse.json(
        { success: false, error: 'Job not found' },
        { status: 404 }
      );
    }

    // Check if job is already completed or cancelled
    if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
      console.log(`[Transcription] Job ${jobId} is already ${job.status}, skipping`);
      return NextResponse.json({
        success: true,
        status: job.status,
        message: `Job already ${job.status}`,
      });
    }

    // Mark job as downloading
    await updateTranscriptionJobStatus(jobId, {
      status: 'downloading',
      progress: 10,
      currentStage: 'Downloading audio from YouTube',
      startedAt: new Date(),
    }, { client: supabase });

    console.log(`[Transcription] Downloading audio for ${job.youtubeId}`);

    // Download audio using Cobalt
    let audioResult;
    try {
      audioResult = await extractYouTubeAudio(job.youtubeId);
      console.log(`[Transcription] Audio downloaded: ${audioResult.size} bytes`);
    } catch (downloadError) {
      console.error(`[Transcription] Failed to download audio:`, downloadError);
      await handleJobFailure(jobId, supabase, 'Failed to download audio from YouTube');
      return NextResponse.json(
        { success: false, error: 'Failed to download audio' },
        { status: 500 }
      );
    }

    // Update progress
    await updateTranscriptionJobStatus(jobId, {
      status: 'transcribing',
      progress: 30,
      currentStage: 'Transcribing audio with AI',
    }, { client: supabase });

    console.log(`[Transcription] Starting Gemini transcription`);

    // Convert to File for Gemini API
    const audioFile = createAudioFile(audioResult);

    // Transcribe with Gemini
    let transcriptionResult;
    try {
      transcriptionResult = await transcribeAudio(audioFile, {
        language: undefined, // Auto-detect
      }, (progress) => {
        // Update progress during transcription
        const transcriptionProgress = 30 + Math.floor(progress.progress * 0.6); // 30-90%
        updateTranscriptionJobStatus(jobId, {
          progress: transcriptionProgress,
          currentStage: progress.stage === 'uploading'
            ? 'Uploading audio to AI'
            : progress.stage === 'transcribing'
              ? 'Transcribing audio with AI'
              : 'Processing transcript',
        }, { client: supabase }).catch(console.error);
      });

      console.log(`[Transcription] Gemini completed: ${transcriptionResult.segments.length} segments`);
    } catch (geminiError) {
      console.error(`[Transcription] Gemini API failed:`, geminiError);
      await handleJobFailure(jobId, supabase, 'AI transcription failed');
      return NextResponse.json(
        { success: false, error: 'Transcription failed' },
        { status: 500 }
      );
    }

    // Update progress
    await updateTranscriptionJobStatus(jobId, {
      progress: 90,
      currentStage: 'Finalizing transcript',
    }, { client: supabase });

    // Consume credits
    const durationMinutes = Math.ceil(transcriptionResult.duration / 60);
    const consumeResult = await consumeTranscriptionMinutes(
      job.userId,
      jobId,
      durationMinutes,
      { client: supabase }
    );

    if (!consumeResult.success) {
      console.error(`[Transcription] Failed to consume credits:`, consumeResult.error);
      // Don't fail the job, credits will be handled manually
    }

    // Mark job as completed
    await updateTranscriptionJobStatus(jobId, {
      status: 'completed',
      progress: 100,
      currentStage: 'Complete',
      transcriptData: transcriptionResult.segments,
      completedAt: new Date(),
    }, { client: supabase });

    const processingTime = Date.now() - startTime;
    console.log(`[Transcription] Job ${jobId} completed in ${processingTime}ms`);

    return NextResponse.json({
      success: true,
      status: 'completed',
      segmentCount: transcriptionResult.segments.length,
      duration: transcriptionResult.duration,
      language: transcriptionResult.language,
      processingTimeMs: processingTime,
    });
  } catch (error) {
    console.error('[Transcription] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * Handle job failure and refund credits if consumed
 */
async function handleJobFailure(
  jobId: string,
  supabase: ReturnType<typeof createServiceRoleClient>,
  errorMessage: string
): Promise<void> {
  await updateTranscriptionJobStatus(jobId, {
    status: 'failed',
    errorMessage,
    completedAt: new Date(),
  }, { client: supabase });

  // Refund any consumed credits
  await refundTranscriptionMinutes(jobId, { client: supabase });
}
