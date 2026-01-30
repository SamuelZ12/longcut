"use client";

import { useState, useEffect, useCallback } from "react";

const NOTES_STORAGE_PREFIX = "longcut-notes-";

export interface LocalNote {
    id: string;
    text: string;
    timestamp?: number; // Video timestamp in seconds
    thumbnailUrl?: string; // Video thumbnail at that moment
    createdAt: number;
    updatedAt: number;
    source?: "manual" | "selection" | "ai";
    selectedText?: string; // Original text if from selection
}

interface UseLocalNotesOptions {
    videoId: string;
}

export function useLocalNotes({ videoId }: UseLocalNotesOptions) {
    const [notes, setNotes] = useState<LocalNote[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    const storageKey = `${NOTES_STORAGE_PREFIX}${videoId}`;

    // Load notes from localStorage
    useEffect(() => {
        if (!videoId) {
            setNotes([]);
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        try {
            const stored = localStorage.getItem(storageKey);
            if (stored) {
                setNotes(JSON.parse(stored));
            } else {
                setNotes([]);
            }
        } catch {
            setNotes([]);
        }
        setIsLoading(false);
    }, [videoId, storageKey]);

    // Save notes to localStorage
    const saveToStorage = useCallback(
        (updatedNotes: LocalNote[]) => {
            localStorage.setItem(storageKey, JSON.stringify(updatedNotes));
        },
        [storageKey]
    );

    // Add a new note
    const addNote = useCallback(
        (noteData: Omit<LocalNote, "id" | "createdAt" | "updatedAt">) => {
            const now = Date.now();
            const newNote: LocalNote = {
                ...noteData,
                id: `note-${now}-${Math.random().toString(36).substr(2, 9)}`,
                createdAt: now,
                updatedAt: now,
            };

            setNotes((prev) => {
                const updated = [newNote, ...prev];
                saveToStorage(updated);
                return updated;
            });

            return newNote;
        },
        [saveToStorage]
    );

    // Update an existing note
    const updateNote = useCallback(
        (noteId: string, updates: Partial<Omit<LocalNote, "id" | "createdAt">>) => {
            setNotes((prev) => {
                const updated = prev.map((note) =>
                    note.id === noteId
                        ? { ...note, ...updates, updatedAt: Date.now() }
                        : note
                );
                saveToStorage(updated);
                return updated;
            });
        },
        [saveToStorage]
    );

    // Delete a note
    const deleteNote = useCallback(
        (noteId: string) => {
            setNotes((prev) => {
                const updated = prev.filter((note) => note.id !== noteId);
                saveToStorage(updated);
                return updated;
            });
        },
        [saveToStorage]
    );

    // Clear all notes for this video
    const clearNotes = useCallback(() => {
        localStorage.removeItem(storageKey);
        setNotes([]);
    }, [storageKey]);

    // Create a note with "screenshot" (timestamp + thumbnail)
    const addNoteWithScreenshot = useCallback(
        (
            text: string,
            currentTime: number,
            videoThumbnail: string,
            source: LocalNote["source"] = "manual"
        ) => {
            return addNote({
                text,
                timestamp: currentTime,
                thumbnailUrl: videoThumbnail,
                source,
            });
        },
        [addNote]
    );

    return {
        notes,
        isLoading,
        addNote,
        updateNote,
        deleteNote,
        clearNotes,
        addNoteWithScreenshot,
    };
}

// Helper to get thumbnail URL for a YouTube video
export function getYouTubeThumbnail(
    videoId: string,
    quality: "default" | "medium" | "high" | "maxres" = "medium"
): string {
    const qualityMap = {
        default: "default",
        medium: "mqdefault",
        high: "hqdefault",
        maxres: "maxresdefault",
    };
    return `https://img.youtube.com/vi/${videoId}/${qualityMap[quality]}.jpg`;
}
