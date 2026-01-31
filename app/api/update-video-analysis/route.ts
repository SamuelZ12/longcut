import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';

interface UpdateResult {
  success: boolean;
  video_id: string | null;
}

async function handler(req: NextRequest) {
  try {
    const {
      videoId,
      summary,
      suggestedQuestions
    } = await req.json();

    if (!videoId) {
      return NextResponse.json(
        { error: 'Video ID is required' },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // Get authenticated user (required by SECURITY_PRESETS.AUTHENTICATED)
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Use secure update function with ownership verification
    // Note: The function returns TABLE (success boolean, video_id uuid)
    // which returns as an array of rows, not a single object
    const { data: resultRows, error: updateError } = await supabase
      .rpc('update_video_analysis_secure', {
        p_youtube_id: videoId,
        p_user_id: user.id,
        p_summary: summary ?? null,
        p_suggested_questions: suggestedQuestions ?? null
      });

    if (updateError) {
      console.error('Error updating video analysis:', {
        message: updateError.message,
        details: updateError.details,
        hint: updateError.hint,
        code: updateError.code,
        videoId,
        userId: user.id
      });
      return NextResponse.json(
        { error: 'Failed to update video analysis', details: updateError.message },
        { status: 500 }
      );
    }

    // The function returns a table (array of rows), get the first result
    const result = Array.isArray(resultRows) && resultRows.length > 0
      ? resultRows[0] as UpdateResult
      : null;

    if (!result) {
      console.error('No result returned from update_video_analysis_secure');
      return NextResponse.json(
        { error: 'Failed to update video analysis: No result' },
        { status: 500 }
      );
    }

    // Check if update was authorized
    if (!result.success) {
      return NextResponse.json(
        { error: 'Not authorized to update this video analysis' },
        { status: 403 }
      );
    }

    return NextResponse.json({
      success: true,
      videoId: result.video_id
    });

  } catch (error) {
    console.error('Error in update video analysis:', error);
    return NextResponse.json(
      { error: 'Failed to process update request' },
      { status: 500 }
    );
  }
}

// Require authentication and CSRF protection for state-changing operations
export const POST = withSecurity(handler, SECURITY_PRESETS.AUTHENTICATED);
