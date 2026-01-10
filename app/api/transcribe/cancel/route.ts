import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { cancelTranscriptionJob } from '@/lib/transcription-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { jobId } = body;

    if (!jobId || typeof jobId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid jobId' },
        { status: 400 }
      );
    }

    // Verify the job belongs to the user
    const { data: job, error: fetchError } = await supabase
      .from('transcription_jobs')
      .select('id, user_id, status')
      .eq('id', jobId)
      .maybeSingle();

    if (fetchError) {
      console.error('Error fetching transcription job:', fetchError);
      return NextResponse.json(
        { success: false, error: 'Failed to fetch job' },
        { status: 500 }
      );
    }

    if (!job) {
      return NextResponse.json(
        { success: false, error: 'Job not found' },
        { status: 404 }
      );
    }

    if (job.user_id !== user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 403 }
      );
    }

    // Check if job can be cancelled
    const cancellableStatuses = ['pending', 'downloading', 'transcribing'];
    if (!cancellableStatuses.includes(job.status)) {
      return NextResponse.json(
        { success: false, error: `Cannot cancel job with status: ${job.status}` },
        { status: 400 }
      );
    }

    // Cancel the job
    const result = await cancelTranscriptionJob(jobId, { client: supabase });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Job cancelled successfully',
    });
  } catch (error) {
    console.error('Error cancelling transcription job:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
