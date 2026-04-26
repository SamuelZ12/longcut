"use client";

import React, { useState, useEffect } from "react";
import { Topic, TranslationRequestHandler } from "@/lib/types";
import { formatDuration, getTopicHSLColor } from "@/lib/utils";
import { cn } from "@/lib/utils";

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
  const topicColor = getTopicHSLColor(topicIndex, videoId);
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
        "w-full px-3 py-1.5 rounded-xl",
        "flex items-center justify-between gap-2.5",
        "transition-all duration-200",
        "hover:scale-[1.01] hover:shadow-[0px_0px_11px_0px_rgba(0,0,0,0.1)]",
        "text-left",
        isSelected && "scale-[1.01] shadow-[0px_0px_11px_0px_rgba(0,0,0,0.1)]",
      )}
      style={{
        backgroundColor: isSelected
          ? `hsl(${topicColor} / 0.15)`
          : `hsl(${topicColor} / 0.08)`,
      }}
      onClick={handleClick}
    >
      <div className="flex items-start gap-2 flex-1 min-w-0">
        <div
          className={cn(
            "rounded-full shrink-0 transition-all mt-0.5",
            isSelected ? "w-3.5 h-3.5" : "w-3 h-3"
          )}
          style={{ backgroundColor: `hsl(${topicColor})` }}
        />
        <div className="flex-1 min-w-0">
          <span className="font-medium text-sm truncate block">
            {selectedLanguage !== null
              ? (isLoadingTranslation ? "Translating..." : translatedTitle || topic.title)
              : topic.title
            }
          </span>
        </div>
      </div>

      <span className="font-mono text-xs text-muted-foreground shrink-0">
        {formatDuration(topic.duration)}
      </span>
    </button>
  );
}
