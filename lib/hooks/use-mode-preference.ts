"use client";

import { useState, useEffect, useCallback } from "react";
import type { TopicGenerationMode } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/contexts/auth-context";
import { shouldForceSmartModeOnClient } from "@/lib/ai-providers/client-config";

const STORAGE_KEY = "tldw-mode-preference";
const FORCE_SMART_MODE = shouldForceSmartModeOnClient();
const DEFAULT_MODE: TopicGenerationMode = FORCE_SMART_MODE ? "smart" : "fast";

/**
 * Custom hook for managing topic generation mode preference
 * - For authenticated users: syncs with database profile
 * - For anonymous users: uses localStorage
 */
export function useModePreference() {
  const { user } = useAuth();
  const [mode, setMode] = useState<TopicGenerationMode>(DEFAULT_MODE);
  const [isLoading, setIsLoading] = useState(!FORCE_SMART_MODE);

  // Load initial preference
  useEffect(() => {
    if (FORCE_SMART_MODE) {
      setMode("smart");
      setIsLoading(false);
      return;
    }

    const loadPreference = async () => {
      if (user) {
        // Fetch from database for authenticated users
        try {
          const supabase = createClient();
          const { data: profile } = await supabase
            .from("profiles")
            .select("topic_generation_mode")
            .eq("id", user.id)
            .single();

          if (profile?.topic_generation_mode) {
            setMode(profile.topic_generation_mode);
          }
        } catch (error) {
          console.error("Failed to load mode preference from database:", error);
          // Fall back to localStorage
          const stored = localStorage.getItem(STORAGE_KEY);
          if (stored === "fast" || stored === "smart") {
            setMode(stored);
          }
        }
      } else {
        // Load from localStorage for anonymous users
        try {
          const stored = localStorage.getItem(STORAGE_KEY);
          if (stored === "fast" || stored === "smart") {
            setMode(stored);
          }
        } catch (error) {
          console.error("Failed to load mode preference from localStorage:", error);
        }
      }
      setIsLoading(false);
    };

    loadPreference();
  }, [user]);

  // Update preference
  const updateMode = useCallback(
    async (newMode: TopicGenerationMode) => {
      if (FORCE_SMART_MODE) {
        setMode("smart");
        return;
      }

      setMode(newMode);

      if (user) {
        // Save to database for authenticated users
        try {
          const supabase = createClient();
          await supabase
            .from("profiles")
            .update({
              topic_generation_mode: newMode,
              updated_at: new Date().toISOString()
            })
            .eq("id", user.id);
        } catch (error) {
          console.error("Failed to save mode preference to database:", error);
        }
      }

      // Always save to localStorage as backup
      try {
        localStorage.setItem(STORAGE_KEY, newMode);
      } catch (error) {
        console.error("Failed to save mode preference to localStorage:", error);
      }
    },
    [user]
  );

  return {
    mode,
    setMode: updateMode,
    isLoading
  };
}
