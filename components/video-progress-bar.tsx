"use client";

import React, { useRef } from "react";
import { Topic, TranscriptSegment, TranslationRequestHandler } from "@/lib/types";
import { getTopicHSLColor } from "@/lib/utils";
import { TopicCard } from "@/components/topic-card";
import { cn } from "@/lib/utils";

interface VideoProgressBarProps {
  videoDuration: number;
  currentTime: number;
  topics: Topic[];
  selectedTopic: Topic | null;
  onSeek: (time: number) => void;
  onTopicSelect?: (topic: Topic, fromPlayAll?: boolean) => void;
  onPlayTopic?: (topic: Topic) => void;
  transcript?: TranscriptSegment[];
  isLoadingThemeTopics?: boolean;
  videoId?: string;
  selectedLanguage?: string | null;
  onRequestTranslation?: TranslationRequestHandler;
}

export function VideoProgressBar({
  videoDuration,
  currentTime,
  topics,
  selectedTopic,
  onSeek,
  onTopicSelect,
  onPlayTopic,
  videoId,
  selectedLanguage = null,
  onRequestTranslation,
}: VideoProgressBarProps) {
  const progressBarRef = useRef<HTMLDivElement>(null);
  const hasDuration = videoDuration > 0;

  const handleBackgroundClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Clicking empty space seeks to that position
    if (!progressBarRef.current) return;

    const rect = progressBarRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const clickTime = percentage * videoDuration;

    onSeek(clickTime);
  };

  const handleTopicClick = (e: React.MouseEvent<HTMLDivElement>, topic: Topic) => {
    // Clicking a topic auto-plays it
    e.stopPropagation();
    onTopicSelect?.(topic);
    onPlayTopic?.(topic);
  };

  // Calculate topic density heatmap
  const calculateDensity = () => {
    if (!videoDuration) return [];
    const buckets = 100; // Number of heatmap segments
    const bucketSize = videoDuration / buckets;
    const density = new Array(buckets).fill(0);

    topics.forEach((topic) => {
      topic.segments.forEach((segment) => {
        const startBucket = Math.floor(segment.start / bucketSize);
        const endBucket = Math.min(
          Math.floor(segment.end / bucketSize),
          buckets - 1
        );
        for (let i = startBucket; i <= endBucket; i++) {
          density[i]++;
        }
      });
    });

    const maxDensity = Math.max(...density);
    return density.map((d) => d / maxDensity);
  };

  const density = calculateDensity();

  // Flatten segments for rendering without nested maps
  const allSegments = hasDuration
    ? topics.flatMap((topic, topicIndex) =>
      topic.segments.map((segment, segmentIndex) => ({
        key: `${topic.id}-${segmentIndex}`,
        topic,
        topicIndex,
        segment,
        segmentIndex,
      }))
    )
    : [];

  const getSegmentStyles = (segment: Topic['segments'][number]) => {
    const startPercentage = (segment.start / videoDuration) * 100;
    const widthPercentage = ((segment.end - segment.start) / videoDuration) * 100;
    const minWidth = 1; // Ensure tiny segments are still clickable

    return {
      left: `${startPercentage}%`,
      width: `${Math.max(widthPercentage, minWidth)}%`,
    };
  };

  return (
    <div className="relative w-full space-y-2">
      {/* Main progress bar - Click to navigate */}
      {hasDuration && (
        <div
          ref={progressBarRef}
          className="relative h-12 bg-muted rounded-lg overflow-hidden cursor-pointer group transition-all hover:ring-2 hover:ring-primary/50"
          onClick={handleBackgroundClick}
        >
          {/* Heatmap background */}
          <div className="absolute inset-0 flex pointer-events-none">
            {density.map((d, i) => (
              <div
                key={i}
                className="flex-1 h-full transition-opacity"
                style={{
                  backgroundColor: `hsl(var(--primary) / ${d * 0.2})`,
                }}
              />
            ))}
          </div>

          {/* Topic segments */}
          <div className="absolute inset-0 z-20">
            {allSegments.map(({ key, topic, topicIndex, segment }) => {
              const isSelected = selectedTopic?.id === topic.id;
              const { left, width } = getSegmentStyles(segment);

              return (
                <div
                  key={key}
                  className={cn(
                    "absolute top-2 h-8 rounded-md transition-all cursor-pointer hover:opacity-100 hover:scale-105",
                    isSelected && "z-30 ring-2 ring-white"
                  )}
                  style={{
                    left,
                    width,
                    backgroundColor: `hsl(${getTopicHSLColor(topicIndex, videoId)})`,
                    opacity: isSelected ? 1 : 0.7,
                  }}
                  onClick={(e) => handleTopicClick(e, topic)}
                />
              );
            })}
          </div>

          {/* Current time indicator */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-30 pointer-events-none transition-all"
            style={{
              left: `${(currentTime / videoDuration) * 100}%`,
            }}
          >
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-full" />
          </div>
        </div>
      )}

      {/* Topic insights list */}
      <div className="mt-3">
        <div className="space-y-2">
          {topics.map((topic, index) => {
            const isSelected = selectedTopic?.id === topic.id;

            return (
              <TopicCard
                key={`${topic.id}:${topic.title}`}
                topic={topic}
                isSelected={isSelected}
                onClick={() => onTopicSelect?.(topic)}
                topicIndex={index}
                onPlayTopic={() => onPlayTopic?.(topic)}
                videoId={videoId}
                selectedLanguage={selectedLanguage}
                onRequestTranslation={onRequestTranslation}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
