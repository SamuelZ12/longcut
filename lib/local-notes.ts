import { Note, NoteSource, NoteMetadata } from './types';

const STORAGE_KEY = 'longcut_local_notes';
const STORAGE_VERSION = 1;

interface LocalNoteData {
  version: number;
  notes: LocalNote[];
}

export interface LocalNote {
  id: string;
  youtubeId: string;
  source: NoteSource;
  sourceId?: string;
  text: string;
  metadata?: NoteMetadata;
  createdAt: string;
  updatedAt: string;
  synced: boolean; // Whether successfully synced to cloud
}

// Get all local notes for a specific video
export function getLocalNotes(youtubeId: string): LocalNote[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];

    const parsed: LocalNoteData = JSON.parse(data);

    // Version migration if needed
    if (parsed.version !== STORAGE_VERSION) {
      migrateStorage(parsed);
    }

    return parsed.notes.filter(note => note.youtubeId === youtubeId);
  } catch (error) {
    console.error('Error reading local notes:', error);
    return [];
  }
}

// Get a single local note by ID
export function getLocalNote(noteId: string): LocalNote | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return null;

    const parsed: LocalNoteData = JSON.parse(data);
    return parsed.notes.find(note => note.id === noteId) || null;
  } catch (error) {
    console.error('Error reading local note:', error);
    return null;
  }
}

// Save a note to localStorage
export function saveLocalNote(
  youtubeId: string,
  source: NoteSource,
  text: string,
  metadata?: NoteMetadata,
  sourceId?: string,
  existingNoteId?: string
): LocalNote {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    let parsed: LocalNoteData = data ? JSON.parse(data) : { version: STORAGE_VERSION, notes: [] };

    const now = new Date().toISOString();

    if (existingNoteId) {
      // Update existing note
      const noteIndex = parsed.notes.findIndex(n => n.id === existingNoteId);
      if (noteIndex !== -1) {
        parsed.notes[noteIndex] = {
          ...parsed.notes[noteIndex],
          text,
          metadata,
          updatedAt: now,
          synced: false, // Mark as needing re-sync
        };
      }
    } else {
      // Create new note
      const newNote: LocalNote = {
        id: `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        youtubeId,
        source,
        sourceId,
        text,
        metadata,
        createdAt: now,
        updatedAt: now,
        synced: false,
      };
      parsed.notes.push(newNote);
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));

    // Return the saved note
    const savedNote = parsed.notes.find(n =>
      existingNoteId ? n.id === existingNoteId :
      n.youtubeId === youtubeId && n.source === source && n.createdAt === now
    );

    if (!savedNote) {
      throw new Error('Failed to retrieve saved note');
    }

    return savedNote;
  } catch (error) {
    console.error('Error saving local note:', error);
    throw new Error('Failed to save note locally');
  }
}

// Delete a note from localStorage
export function deleteLocalNote(noteId: string): boolean {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return false;

    const parsed: LocalNoteData = JSON.parse(data);
    const initialLength = parsed.notes.length;
    parsed.notes = parsed.notes.filter(note => note.id !== noteId);

    if (parsed.notes.length < initialLength) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error deleting local note:', error);
    return false;
  }
}

// Mark a note as synced to cloud
export function markNoteSynced(noteId: string, cloudNoteId: string): void {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return;

    const parsed: LocalNoteData = JSON.parse(data);
    const note = parsed.notes.find(n => n.id === noteId);

    if (note) {
      note.synced = true;
      // Store the cloud note ID for future reference
      note.metadata = {
        ...note.metadata,
        cloudNoteId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    }
  } catch (error) {
    console.error('Error marking note as synced:', error);
  }
}

// Get all unsynced notes
export function getUnsyncedNotes(): LocalNote[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];

    const parsed: LocalNoteData = JSON.parse(data);
    return parsed.notes.filter(note => !note.synced);
  } catch (error) {
    console.error('Error reading unsynced notes:', error);
    return [];
  }
}

// Clear all local notes (useful for testing)
export function clearLocalNotes(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// Storage migration for future versions
function migrateStorage(parsed: LocalNoteData): void {
  // Handle version migrations here if needed
  parsed.version = STORAGE_VERSION;
}

// Get storage usage info
export function getStorageInfo(): { used: number; total: number; noteCount: number } {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    const used = data ? new Blob([data]).size : 0;
    const total = 5 * 1024 * 1024; // 5MB typical localStorage limit

    const parsed: LocalNoteData = data ? JSON.parse(data) : { version: STORAGE_VERSION, notes: [] };

    return {
      used,
      total,
      noteCount: parsed.notes.length,
    };
  } catch (error) {
    return { used: 0, total: 5 * 1024 * 1024, noteCount: 0 };
  }
}
