import { csrfFetch } from '@/lib/csrf-client';
import { Note, NoteMetadata, NoteSource, NoteWithVideo } from '@/lib/types';
import {
  saveLocalNote,
  getLocalNotes,
  deleteLocalNote,
  markNoteSynced,
  type LocalNote
} from '@/lib/local-notes';

interface SaveNotePayload {
  youtubeId: string;
  videoId?: string;
  source: NoteSource;
  sourceId?: string;
  text: string;
  metadata?: NoteMetadata;
  existingNoteId?: string; // For editing existing notes
}

/**
 * Convert LocalNote to Note format
 */
function localToNote(localNote: LocalNote): Note {
  return {
    id: localNote.id,
    userId: 'local',
    videoId: localNote.youtubeId,
    source: localNote.source,
    sourceId: localNote.sourceId,
    text: localNote.text,
    metadata: localNote.metadata,
    createdAt: localNote.createdAt,
    updatedAt: localNote.updatedAt,
  };
}

/**
 * Merge local and cloud notes, removing duplicates
 */
function mergeNotes(localNotes: LocalNote[], cloudNotes: Note[]): Note[] {
  const noteMap = new Map<string, Note>();

  // Add cloud notes first
  cloudNotes.forEach(note => {
    noteMap.set(note.id, note);
  });

  // Override/add local notes (local takes precedence)
  localNotes.forEach(localNote => {
    noteMap.set(localNote.id, localToNote(localNote));
  });

  // Convert to array and sort by updated time
  return Array.from(noteMap.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Fetch notes - combines local and cloud notes
 */
export async function fetchNotes(params: { youtubeId: string }): Promise<Note[]> {
  // Get local notes first
  const localNotes = getLocalNotes(params.youtubeId);

  // Try to fetch cloud notes
  try {
    const query = new URLSearchParams();
    query.set('youtubeId', params.youtubeId);

    const response = await csrfFetch.get(`/api/notes?${query.toString()}`);

    if (response.ok) {
      const data = await response.json();
      const cloudNotes = (data.notes || []) as Note[];

      // Merge local and cloud notes
      // Local notes take precedence for unsynced notes
      const mergedNotes = mergeNotes(localNotes, cloudNotes);
      return mergedNotes;
    }
  } catch (error) {
    console.warn('Failed to fetch cloud notes, using local only:', error);
  }

  // Return only local notes if cloud fetch failed
  return localNotes.map(localToNote);
}

/**
 * Save note - saves to local first, then tries to sync to cloud
 */
export async function saveNote(payload: SaveNotePayload): Promise<Note> {
  const { youtubeId, source, text, metadata, sourceId, existingNoteId } = payload;

  // Step 1: Always save to localStorage first (immediate success)
  const localNote = saveLocalNote(
    youtubeId,
    source,
    text,
    metadata,
    sourceId,
    existingNoteId
  );

  // Step 2: Try to sync to cloud in background (non-blocking)
  syncToCloud(payload, localNote.id).catch((error) => {
    console.warn('Failed to sync note to cloud:', error);
    // Note remains in localStorage, can be synced later
  });

  // Return immediately with local note
  return localToNote(localNote);
}

/**
 * Background sync to cloud
 */
async function syncToCloud(payload: SaveNotePayload, localNoteId: string): Promise<void> {
  try {
    const response = await csrfFetch.post('/api/notes', payload);

    if (response.ok) {
      const data = await response.json();
      const cloudNote = data.note as Note;

      // Mark local note as synced
      markNoteSynced(localNoteId, cloudNote.id);
    } else {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.error || 'Failed to sync to cloud');
    }
  } catch (error) {
    // Don't throw - local save already succeeded
    console.warn('Cloud sync failed, keeping local note:', error);
  }
}

/**
 * Delete note - removes from both local and cloud
 */
export async function deleteNote(noteId: string): Promise<void> {
  // Delete from local first
  deleteLocalNote(noteId);

  // Try to delete from cloud
  try {
    const response = await csrfFetch.delete('/api/notes', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noteId }),
    });

    if (!response.ok) {
      console.warn('Failed to delete note from cloud:', await response.text());
    }
  } catch (error) {
    console.warn('Cloud delete failed:', error);
  }
}

export async function enhanceNoteQuote(quote: string): Promise<string> {
  // Use regular fetch instead of csrfFetch for anonymous access
  const response = await fetch('/api/notes/enhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quote }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || 'Failed to enhance note');
  }

  const data = await response.json().catch(() => ({}));
  const cleanedText = typeof data.cleanedText === 'string' ? data.cleanedText.trim() : '';

  if (!cleanedText) {
    throw new Error('Enhancement returned no text');
  }

  return cleanedText;
}

export async function fetchAllNotes(): Promise<NoteWithVideo[]> {
  const response = await csrfFetch.get('/api/notes/all');

  if (!response.ok) {
    throw new Error('Failed to fetch all notes');
  }

  const data = await response.json();
  return (data.notes || []) as NoteWithVideo[];
}

// Export types for use in components
export type { LocalNote };
