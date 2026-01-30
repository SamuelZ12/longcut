"use client";

import { useState, useEffect } from "react";
import { Topic, TranslationRequestHandler } from "@/lib/types";
import { formatDuration, getTopicHSLColor } from "@/lib/utils";
import { cn } from "@/lib/utils";

// Pastel color palette from reference design
const CATEGORY_COLORS = [
  "#FF8A80", // Coral
  "#80CBC4", // Mint green
  "#F48FB1", // Light pink
  "#B39DDB", // Lavender
  "#81D4FA", // Light blue
];

interface TopicCardProps {
  topic: Topic;
  isSelected: boolean;
  onClick: () => void;
  topicIndex: number;
  onPlayTopic?: () => void;
  videoId?: string;
  selectedLanguage?: string | null;
  onRequestTranslation?: TranslationRequestHandler;
}

export function TopicCard({ topic, isSelected, onClick, topicIndex, onPlayTopic, videoId, selectedLanguage = null, onRequestTranslation }: TopicCardProps) {
  const topicColor = CATEGORY_COLORS[topicIndex % CATEGORY_COLORS.length];
  const [translatedTitle, setTranslatedTitle] = useState<string | null>(null);
  const [isLoadingTranslation, setIsLoadingTranslation] = useState(false);

  // Single consolidated effect to handle translation when language or topic changes
  // This fixes the race condition where separate effects could run out of order
  useEffect(() => {
    // Always reset translation state when dependencies change
    setTranslatedTitle(null);
    setIsLoadingTranslation(false);

    // No translation needed if no language selected or no translation handler
    if (!selectedLanguage || !onRequestTranslation) {
      return;
    }

    // Request translation
    setIsLoadingTranslation(true);

    // Cache key includes source text to avoid collisions when topic ids are reused
    const cacheKey = `topic-title:${selectedLanguage}:${topic.title}`;

    let isCancelled = false;

    onRequestTranslation(topic.title, cacheKey, 'topic')
      .then(translation => {
        if (!isCancelled) {
          setTranslatedTitle(translation);
        }
      })
      .catch(error => {
        if (!isCancelled) {
          console.error('Translation failed for topic:', topic.id, error);
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingTranslation(false);
        }
      });

    // Cleanup function to handle component unmount or dependency changes
    return () => {
      isCancelled = true;
    };
  }, [selectedLanguage, onRequestTranslation, topic.title, topic.id]);

  const handleClick = () => {
    onClick();
    // Automatically play the topic when clicked
    if (onPlayTopic) {
      onPlayTopic();
    }
  };

  return (
    <button
      className={cn(
        "w-full px-3 py-2 rounded-xl",
        "flex items-center justify-between gap-2.5",
        "transition-all duration-200",
        "hover:scale-[1.01]",
        "text-left",
        isSelected ? "shadow-md" : "shadow-sm"
      )}
      style={{
        backgroundColor: isSelected ? "rgba(129, 212, 250, 0.25)" : "rgba(255, 255, 255, 0.7)",
        borderLeft: isSelected ? "3px solid #81D4FA" : "none",
      }}
      onClick={handleClick}
    >
      <div className="flex items-start gap-2 flex-1 min-w-0">
        <div
          className="rounded-full shrink-0 mt-0.5 w-3 h-3 transition-all shadow-sm"
          style={{ backgroundColor: topicColor }}
        />
        <div className="flex-1 min-w-0">
          <span className="text-sm truncate block text-gray-800 font-medium">
            {selectedLanguage !== null
              ? (isLoadingTranslation ? "Translating..." : translatedTitle || topic.title)
              : topic.title
            }
          </span>
        </div>
      </div>

      <span className="font-mono text-xs text-gray-600 shrink-0">
        {formatDuration(topic.duration)}
      </span>
    </button>
  );
}
