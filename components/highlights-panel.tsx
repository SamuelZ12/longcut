"use client";

import { useState, useEffect } from "react";
import { Topic, TranscriptSegment, TranslationRequestHandler } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { VideoProgressBar } from "@/components/video-progress-bar";
import { formatDuration, cn } from "@/lib/utils";
import { Play, Pause, Loader2 } from "lucide-react";

// Default English labels
const DEFAULT_LABELS = {
  playAll: "Play All",
  stop: "Stop",
  generatingYourReels: "Generating your reels...",
};

// Pastel color palette from reference design
const CATEGORY_COLORS = [
  "bg-[#FF8A80]", // Coral
  "bg-[#80CBC4]", // Mint green
  "bg-[#F48FB1]", // Light pink
  "bg-[#B39DDB]", // Lavender
  "bg-[#81D4FA]", // Light blue
];

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
      ]);

      if (!isCancelled) {
        setTranslatedLabels({
          playAll: translations[0],
          stop: translations[1],
          generatingYourReels: translations[2],
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

  // Get color for topic based on index
  const getTopicColor = (index: number) => {
    return CATEGORY_COLORS[index % CATEGORY_COLORS.length];
  };

  return (
    <Card
      className="overflow-hidden p-0 border-0 relative"
      style={{
        background: "linear-gradient(135deg, #E3F2FD 0%, #BBDEFB 30%, #90CAF9 70%, #64B5F6 100%)",
      }}
    >
      <div
        className={cn(
          "p-2.5 flex-shrink-0 transition-all duration-200",
          "bg-white/40 backdrop-blur-md rounded-2xl",
          "border border-blue-100 shadow-lg",
          isLoadingThemeTopics && "blur-[4px] opacity-50 pointer-events-none"
        )}
      >
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

        <div className="mt-3 flex items-center justify-between">
          <div className="ml-2.5 flex items-center gap-1.5">
            <span className="text-xs font-mono text-gray-700 font-medium">
              {formatDuration(currentTime)} / {formatDuration(videoDuration)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={isPlayingAll ? "secondary" : "default"}
              onClick={onPlayAll}
              className="h-8 px-4 text-xs text-white border-0 shadow-md rounded-full"
              style={{
                background: "linear-gradient(135deg, #81D4FA 0%, #4FC3F7 100%)",
              }}
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
        </div>
      </div>

      {/* Loading overlay */}
      {isLoadingThemeTopics && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 pointer-events-none">
          <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
          <p className="text-sm font-medium text-white drop-shadow-md">
            {translatedLabels.generatingYourReels}
          </p>
        </div>
      )}
    </Card>
  );
}
