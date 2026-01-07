import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { formatValidationError, noteDeleteSchema, noteInsertSchema, youtubeIdSchema } from '@/lib/validation';
import { z } from 'zod';

const getNotesQuerySchema = z.object({
  youtubeId: youtubeIdSchema
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

    try {
      const { youtubeId: validatedYoutubeId } = getNotesQuerySchema.parse({ youtubeId });

      const { data: videos, error: videoError } = await supabase
        .from('video_analyses')
        .select('id')
        .eq('youtube_id', validatedYoutubeId)
        .order('created_at', { ascending: false })
        .limit(1);

      if (videoError) {
        throw videoError;
      }

      const video = videos?.[0];

      if (!video?.id) {
        return NextResponse.json({ notes: [] });
      }

      const { data, error } = await supabase
        .from('user_notes')
        .select('*')
        .eq('user_id', user.id)
        .eq('video_id', video.id)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      const notes = (data || []).map(mapNote);

      return NextResponse.json({ notes });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { error: 'Validation failed', details: formatValidationError(error) },
          { status: 400 }
        );
      }

      console.error('Error fetching notes:', error);
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

      const youtubeId = validatedData.youtubeId;

      if (!youtubeId) {
        return NextResponse.json(
          { error: 'youtubeId is required' },
          { status: 400 }
        );
      }

      const { data: videos, error: videoError } = await supabase
        .from('video_analyses')
        .select('id')
        .eq('youtube_id', youtubeId)
        .order('created_at', { ascending: false })
        .limit(1);

      if (videoError) {
        throw videoError;
      }

      const video = videos?.[0];

      if (!video?.id) {
        return NextResponse.json(
          { error: 'Video not found' },
          { status: 404 }
        );
      }

      const { data: noteRow, error } = await supabase
        .from('user_notes')
        .insert({
          user_id: user.id,
          video_id: video.id,
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
