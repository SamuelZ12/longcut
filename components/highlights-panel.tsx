"use client";

import React, { useState, useEffect } from "react";
import { Topic, TranscriptSegment, TranslationRequestHandler } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { VideoProgressBar } from "@/components/video-progress-bar";
import { formatDuration, cn } from "@/lib/utils";
import { Play, Pause, Loader2, Sparkles } from "lucide-react";

// Default English labels
const DEFAULT_LABELS = {
  playAll: "Play All",
  stop: "Stop",
  generatingYourReels: "Creating highlight reels...",
  analyzingAndGenerating: "Analyzing video and generating highlight reels",
  generateHighlightReels: "Generate highlight reels",
  generateDescription: "AI will scan the full transcript and create highlight reels - the most insightful moments organized by topic.",
  tryAgain: "Try again",
};

interface HighlightsPanelProps {
  topics: Topic[];
  selectedTopic: Topic | null;
  onTopicSelect: (topic: Topic) => void;
  onPlayTopic?: (topic: Topic) => void;
  onSeek: (time: number) => void;
  onPlayAll: () => void;
  isPlayingAll: boolean;
  playAllIndex?: number;
  currentTime: number;
  videoDuration: number;
  transcript?: TranscriptSegment[];
  isLoadingThemeTopics?: boolean;
  videoId?: string;
  selectedLanguage?: string | null;
  onRequestTranslation?: TranslationRequestHandler;
  onGenerateHighlights?: () => void;
  isGeneratingHighlights?: boolean;
  highlightGenerationElapsedTime?: number;
  highlightGenerationError?: string | null;
}

export function HighlightsPanel({
  topics,
  selectedTopic,
  onTopicSelect,
  onPlayTopic,
  onSeek,
  onPlayAll,
  isPlayingAll,
  currentTime,
  videoDuration,
  transcript = [],
  isLoadingThemeTopics = false,
  videoId,
  selectedLanguage = null,
  onRequestTranslation,
  onGenerateHighlights,
  isGeneratingHighlights = false,
  highlightGenerationElapsedTime = 0,
  highlightGenerationError = null,
}: HighlightsPanelProps) {
  // Translation state
  const [translatedLabels, setTranslatedLabels] = useState(DEFAULT_LABELS);

  // Translate labels when language changes
  useEffect(() => {
    if (!selectedLanguage || !onRequestTranslation) {
      setTranslatedLabels(DEFAULT_LABELS);
      return;
    }

    let isCancelled = false;

    const translateLabels = async () => {
      const translations = await Promise.all([
        onRequestTranslation(DEFAULT_LABELS.playAll, `ui_highlights:playAll:${selectedLanguage}`),
        onRequestTranslation(DEFAULT_LABELS.stop, `ui_highlights:stop:${selectedLanguage}`),
        onRequestTranslation(DEFAULT_LABELS.generatingYourReels, `ui_highlights:generatingYourReels:${selectedLanguage}`),
        onRequestTranslation(DEFAULT_LABELS.analyzingAndGenerating, `ui_highlights:analyzingAndGenerating:${selectedLanguage}`),
        onRequestTranslation(DEFAULT_LABELS.generateHighlightReels, `ui_highlights:generateHighlightReels:${selectedLanguage}`),
        onRequestTranslation(DEFAULT_LABELS.generateDescription, `ui_highlights:generateDescription:${selectedLanguage}`),
        onRequestTranslation(DEFAULT_LABELS.tryAgain, `ui_highlights:tryAgain:${selectedLanguage}`),
      ]);

      if (!isCancelled) {
        setTranslatedLabels({
          playAll: translations[0],
          stop: translations[1],
          generatingYourReels: translations[2],
          analyzingAndGenerating: translations[3],
          generateHighlightReels: translations[4],
          generateDescription: translations[5],
          tryAgain: translations[6],
        });
      }
    };

    translateLabels().catch((err) => {
      console.error("Failed to translate highlights panel labels:", err);
      if (!isCancelled) {
        setTranslatedLabels(DEFAULT_LABELS);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [selectedLanguage, onRequestTranslation]);

  const hasTopics = topics.length > 0;
  const showGenerateState = !hasTopics && onGenerateHighlights;
  const isGenerating = isGeneratingHighlights || isLoadingThemeTopics;
  const highlightGenerationLabel =
    isGeneratingHighlights
      ? `${translatedLabels.generatingYourReels} (${highlightGenerationElapsedTime} seconds)`
      : translatedLabels.generatingYourReels;

  return (
    <Card className="overflow-hidden p-0 border-0 relative">
      <div className={cn(
        "p-2.5 bg-background rounded-b-3xl flex-shrink-0 transition-all duration-200",
        isLoadingThemeTopics && hasTopics && "blur-[4px] opacity-50 pointer-events-none"
      )}>
        {showGenerateState && isGeneratingHighlights ? (
          <div className="flex min-h-40 flex-col items-center justify-center px-5 py-7 text-center">
            <Loader2 className="mb-3 h-5 w-5 animate-spin text-slate-900" />
            <h3 className="text-sm font-semibold leading-tight text-slate-700">
              {translatedLabels.analyzingAndGenerating}
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              {highlightGenerationLabel}
            </p>
          </div>
        ) : showGenerateState ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-7 text-center">
            <Sparkles className="mb-3 h-5 w-5 text-primary" />
            <h3 className="text-sm font-semibold text-slate-900">
              {translatedLabels.generateHighlightReels}
            </h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
              {translatedLabels.generateDescription}
            </p>
            {highlightGenerationError && !isGeneratingHighlights && (
              <p className="mt-3 max-w-md text-xs font-medium text-red-600">
                {highlightGenerationError}
              </p>
            )}
            <Button
              type="button"
              size="sm"
              onClick={onGenerateHighlights}
              disabled={isGeneratingHighlights}
              className="mt-4 h-8 text-xs"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {highlightGenerationError ? translatedLabels.tryAgain : translatedLabels.generateHighlightReels}
            </Button>
          </div>
        ) : (
          <VideoProgressBar
            videoDuration={videoDuration}
            currentTime={currentTime}
            topics={topics}
            selectedTopic={selectedTopic}
            onSeek={onSeek}
            onTopicSelect={(topic) => onTopicSelect(topic)}
            onPlayTopic={onPlayTopic}
            transcript={transcript}
            isLoadingThemeTopics={isLoadingThemeTopics}
            videoId={videoId}
            selectedLanguage={selectedLanguage}
            onRequestTranslation={onRequestTranslation}
          />
        )}

        <div className="mt-3 flex items-center justify-between">
          <div className="ml-2.5 flex items-center gap-1.5">
            <span className="text-xs font-mono text-muted-foreground">
              {formatDuration(currentTime)} / {formatDuration(videoDuration)}
            </span>
          </div>
          {hasTopics && (
            <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={isPlayingAll ? "secondary" : "default"}
              onClick={onPlayAll}
              className="h-7 text-xs"
            >
              {isPlayingAll ? (
                <>
                  <Pause className="h-3 w-3 mr-1" />
                  {translatedLabels.stop}
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 mr-1" />
                  {translatedLabels.playAll}
                </>
              )}
            </Button>
            </div>
          )}
        </div>
      </div>

      {/* Loading overlay */}
      {isGenerating && hasTopics && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 pointer-events-none">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <p className="text-sm font-medium text-foreground">
            {highlightGenerationLabel}
          </p>
        </div>
      )}
    </Card>
  );
}
