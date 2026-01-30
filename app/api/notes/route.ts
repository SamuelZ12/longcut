import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { formatValidationError, noteDeleteSchema, noteInsertSchema } from '@/lib/validation';
import { z } from 'zod';

const getNotesQuerySchema = z.object({
  youtubeId: z.string().optional(),
  videoId: z.string().optional()
}).refine(data => data.youtubeId || data.videoId, {
  message: 'Either youtubeId or videoId must be provided'
});

interface NoteRow {
  id: string;
  user_id: string;
  video_id: string;
  source: string;
  source_id: string | null;
  note_text: string;
  metadata: any;
  created_at: string;
  updated_at: string;
}

function mapNote(row: NoteRow) {
  return {
    id: row.id,
    userId: row.user_id,
    videoId: row.video_id,
    source: row.source,
    sourceId: row.source_id,
    text: row.note_text,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handler(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (req.method === 'GET') {
    const { searchParams } = new URL(req.url);
    const youtubeId = searchParams.get('youtubeId');
    const videoIdParam = searchParams.get('videoId');

    // Debug logging
    console.log('📝 [GET /api/notes] Request params:', { youtubeId, videoIdParam, url: req.url });

    try {
      const validated = getNotesQuerySchema.parse({ youtubeId, videoId: videoIdParam });
      console.log('✅ [GET /api/notes] Validation passed:', validated);

      let targetVideoId: string | undefined;

      // If videoId (UUID) is provided directly, skip the video_analyses lookup
      if (validated.videoId) {
        targetVideoId = validated.videoId;
      } else if (validated.youtubeId) {
        // Fallback: lookup by youtube_id
        const { data: videos, error: videoError } = await supabase
          .from('video_analyses')
          .select('id')
          .eq('youtube_id', validated.youtubeId)
          .order('created_at', { ascending: false })
          .limit(1);

        if (videoError) {
          throw videoError;
        }

        targetVideoId = videos?.[0]?.id;
      }

      if (!targetVideoId) {
        return NextResponse.json({ notes: [] });
      }

      const { data, error } = await supabase
        .from('user_notes')
        .select('*')
        .eq('user_id', user.id)
        .eq('video_id', targetVideoId)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      const notes = (data || []).map(mapNote);

      return NextResponse.json({ notes });
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('❌ [GET /api/notes] Zod validation error:', {
          issues: error.issues,
          formattedError: formatValidationError(error)
        });
        return NextResponse.json(
          { error: 'Validation failed', details: formatValidationError(error) },
          { status: 400 }
        );
      }

      console.error('❌ [GET /api/notes] Unexpected error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch notes' },
        { status: 500 }
      );
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const validatedData = noteInsertSchema.parse(body);

      let targetVideoId: string | undefined;

      // If videoId (UUID) is provided directly, skip the video_analyses lookup
      if (validatedData.videoId) {
        targetVideoId = validatedData.videoId;
      } else if (validatedData.youtubeId) {
        // Fallback: lookup by youtube_id
        const { data: videos, error: videoError } = await supabase
          .from('video_analyses')
          .select('id')
          .eq('youtube_id', validatedData.youtubeId)
          .order('created_at', { ascending: false })
          .limit(1);

        if (videoError) {
          throw videoError;
        }

        targetVideoId = videos?.[0]?.id;
      }

      if (!targetVideoId) {
        return NextResponse.json(
          { error: 'Video not found' },
          { status: 404 }
        );
      }

      const { data: noteRow, error } = await supabase
        .from('user_notes')
        .insert({
          user_id: user.id,
          video_id: targetVideoId,
          source: validatedData.source,
          source_id: validatedData.sourceId || null,
          note_text: validatedData.text,
          metadata: validatedData.metadata || {}
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return NextResponse.json({ note: mapNote(noteRow as NoteRow) }, { status: 201 });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { error: 'Validation failed', details: formatValidationError(error) },
          { status: 400 }
        );
      }

      console.error('Error creating note:', error);
      return NextResponse.json(
        { error: 'Failed to save note' },
        { status: 500 }
      );
    }
  }

  if (req.method === 'DELETE') {
    try {
      const body = await req.json();
      const { noteId } = noteDeleteSchema.parse(body);

      const { error } = await supabase
        .from('user_notes')
        .delete()
        .eq('id', noteId)
        .eq('user_id', user.id);

      if (error) {
        throw error;
      }

      return NextResponse.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { error: 'Validation failed', details: formatValidationError(error) },
          { status: 400 }
        );
      }

      console.error('Error deleting note:', error);
      return NextResponse.json(
        { error: 'Failed to delete note' },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

export const GET = withSecurity(handler, SECURITY_PRESETS.AUTHENTICATED);
export const POST = withSecurity(handler, SECURITY_PRESETS.AUTHENTICATED);
export const DELETE = withSecurity(handler, SECURITY_PRESETS.AUTHENTICATED);
