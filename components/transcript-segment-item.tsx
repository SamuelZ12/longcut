"use client";

import React, { memo } from "react";
import { TranscriptSegment, Topic, Citation } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface SearchResult {
  segmentIndex: number;
  startIndex: number;
  endIndex: number;
}

interface TranscriptSegmentItemProps {
  segment: TranscriptSegment;
  index: number;
  isCurrent: boolean;
  searchResults: SearchResult[];
  currentResultIndex: number;
  citationHighlight: Citation | null;
  selectedTopic: Topic | null;
  selectedTopicColor: string | null;
  translation: string | undefined;
  isLoadingTranslation: boolean;
  hasTranslationError: boolean;
  translationEnabled: boolean;
  onRequestTranslation: (index: number) => void;
  onSegmentClick: (segment: TranscriptSegment, e: React.MouseEvent) => void;
  setRef: (el: HTMLDivElement | null, index: number, hasHighlight: boolean, isCurrent: boolean) => void;
}

const getHighlightedText = (
  segment: TranscriptSegment,
  segmentIndex: number,
  searchResults: SearchResult[],
  currentResultIndex: number,
  citationHighlight: Citation | null,
  selectedTopic: Topic | null
): { highlightedParts: Array<{ text: string; highlighted: boolean; isCitation?: boolean; isSearchMatch?: boolean; isCurrentSearchMatch?: boolean }> } | null => {
  // Priority: Search > Citation/Topic

  // Check for search matches in this segment
  const segmentSearchResults = searchResults.filter(r => r.segmentIndex === segmentIndex);

  if (segmentSearchResults.length > 0) {
    const text = segment.text;
    const parts: Array<{ text: string; highlighted: boolean; isCitation?: boolean; isSearchMatch?: boolean; isCurrentSearchMatch?: boolean }> = [];
    let lastIndex = 0;

    // Sort matches by start index to handle them in order
    // (Though our search logic generates them in order anyway)

    segmentSearchResults.forEach(match => {
      // Text before match
      if (match.startIndex > lastIndex) {
        parts.push({
          text: text.substring(lastIndex, match.startIndex),
          highlighted: false
        });
      }

      // Match text
      const isCurrent = searchResults[currentResultIndex] === match;
      parts.push({
        text: text.substring(match.startIndex, match.endIndex),
        highlighted: true,
        isSearchMatch: true,
        isCurrentSearchMatch: isCurrent
      });

      lastIndex = match.endIndex;
    });

    // Text after last match
    if (lastIndex < text.length) {
      parts.push({
        text: text.substring(lastIndex),
        highlighted: false
      });
    }

    return { highlightedParts: parts };
  }

  // Determine what segments to highlight based on citation or topic
  const segmentsToHighlight = citationHighlight
    ? [citationHighlight]
    : selectedTopic?.segments || [];

  if (segmentsToHighlight.length === 0) return null;

  const isCitation = !!citationHighlight;

  // Check each segment to see if this transcript segment should be highlighted
  for (const highlightSeg of segmentsToHighlight) {
    // Use segment indices with character offsets for precise matching
    if (highlightSeg.startSegmentIdx !== undefined && highlightSeg.endSegmentIdx !== undefined) {

      // Skip segments that are before the start or after the end
      if (segmentIndex < highlightSeg.startSegmentIdx || segmentIndex > highlightSeg.endSegmentIdx) {
        continue;
      }

      // Case 1: This segment is between start and end (not at boundaries)
      if (segmentIndex > highlightSeg.startSegmentIdx && segmentIndex < highlightSeg.endSegmentIdx) {
        return {
          highlightedParts: [{ text: segment.text, highlighted: true, isCitation }]
        };
      }

      // Case 2: This is the start segment - may need partial highlighting
      if (segmentIndex === highlightSeg.startSegmentIdx) {
        if (highlightSeg.startCharOffset !== undefined && highlightSeg.startCharOffset > 0) {
          // Partial highlight from character offset to end
          const beforeHighlight = segment.text.substring(0, highlightSeg.startCharOffset);
          const highlighted = segment.text.substring(highlightSeg.startCharOffset);

          // If this is also the end segment, apply end offset
          if (segmentIndex === highlightSeg.endSegmentIdx && highlightSeg.endCharOffset !== undefined) {
            const actualHighlighted = segment.text.substring(
              highlightSeg.startCharOffset,
              Math.min(highlightSeg.endCharOffset, segment.text.length)
            );
            const afterHighlight = segment.text.substring(Math.min(highlightSeg.endCharOffset, segment.text.length));

            const parts: Array<{ text: string; highlighted: boolean; isCitation?: boolean }> = [];
            if (beforeHighlight) parts.push({ text: beforeHighlight, highlighted: false });
            if (actualHighlighted) parts.push({ text: actualHighlighted, highlighted: true, isCitation });
            if (afterHighlight) parts.push({ text: afterHighlight, highlighted: false });
            return { highlightedParts: parts };
          }

          const parts: Array<{ text: string; highlighted: boolean; isCitation?: boolean }> = [];
          if (beforeHighlight) parts.push({ text: beforeHighlight, highlighted: false });
          if (highlighted) parts.push({ text: highlighted, highlighted: true, isCitation });
          return { highlightedParts: parts };
        } else {
          // No offset or offset is 0, highlight from beginning
          if (segmentIndex === highlightSeg.endSegmentIdx && highlightSeg.endCharOffset !== undefined) {
            // This is both start and end segment
            const highlighted = segment.text.substring(0, highlightSeg.endCharOffset);
            const afterHighlight = segment.text.substring(highlightSeg.endCharOffset);

            const parts: Array<{ text: string; highlighted: boolean; isCitation?: boolean }> = [];
            if (highlighted) parts.push({ text: highlighted, highlighted: true, isCitation });
            if (afterHighlight) parts.push({ text: afterHighlight, highlighted: false });
            return { highlightedParts: parts };
          }
          // Highlight entire segment
          return {
            highlightedParts: [{ text: segment.text, highlighted: true, isCitation }]
          };
        }
      }

      // Case 3: This is the end segment (only if different from start) - may need partial highlighting
      if (segmentIndex === highlightSeg.endSegmentIdx && segmentIndex !== highlightSeg.startSegmentIdx) {
        if (highlightSeg.endCharOffset !== undefined && highlightSeg.endCharOffset < segment.text.length) {
          // Partial highlight from beginning to character offset
          const highlighted = segment.text.substring(0, highlightSeg.endCharOffset);
          const afterHighlight = segment.text.substring(highlightSeg.endCharOffset);

          const parts: Array<{ text: string; highlighted: boolean; isCitation?: boolean }> = [];
          if (highlighted) parts.push({ text: highlighted, highlighted: true, isCitation });
          if (afterHighlight) parts.push({ text: afterHighlight, highlighted: false });
          return { highlightedParts: parts };
        } else {
          // No offset or offset covers entire segment
          return {
            highlightedParts: [{ text: segment.text, highlighted: true, isCitation }]
          };
        }
      }
    }
  }

  // Only use time-based highlighting if NO segments have index information
  const hasAnySegmentIndices = segmentsToHighlight.some(seg =>
    seg.startSegmentIdx !== undefined && seg.endSegmentIdx !== undefined
  );

  if (!hasAnySegmentIndices) {
    // Fallback to time-based highlighting only if segment indices aren't available at all
    const segmentEnd = segment.start + segment.duration;
    const shouldHighlight = segmentsToHighlight.some(highlightSeg => {
      const overlapStart = Math.max(segment.start, highlightSeg.start);
      const overlapEnd = Math.min(segmentEnd, highlightSeg.end);
      const overlapDuration = Math.max(0, overlapEnd - overlapStart);
      const overlapRatio = overlapDuration / segment.duration;
      // Highlight if there's significant overlap (more than 50% of the segment)
      return overlapRatio > 0.5;
    });

    if (shouldHighlight) {
      return {
        highlightedParts: [{ text: segment.text, highlighted: true, isCitation }]
      };
    }
  }

  return null;
};

const TranscriptSegmentItemComponent = ({
  segment,
  index,
  isCurrent,
  searchResults,
  currentResultIndex,
  citationHighlight,
  selectedTopic,
  selectedTopicColor,
  translation,
  isLoadingTranslation,
  hasTranslationError,
  translationEnabled,
  onRequestTranslation,
  onSegmentClick,
  setRef
}: TranscriptSegmentItemProps) => {
  const highlightedText = getHighlightedText(
    segment,
    index,
    searchResults,
    currentResultIndex,
    citationHighlight,
    selectedTopic
  );

  const hasHighlight = highlightedText !== null;

  // Request translation if enabled and not already cached/loading/errored
  if (translationEnabled && !translation && !isLoadingTranslation && !hasTranslationError) {
    onRequestTranslation(index);
  }

  return (
    <div
      data-segment-index={index}
      ref={(el) => setRef(el, index, hasHighlight, isCurrent)}
      className={cn(
        "group relative px-2.5 py-1.5 rounded-xl transition-all duration-200 cursor-pointer hover:bg-slate-50",
        translationEnabled && "space-y-1"
      )}
      onClick={(e) => onSegmentClick(segment, e)}
    >
      {/* Original text */}
      <p
        className={cn(
          "text-sm leading-relaxed",
          isCurrent ? "text-foreground font-medium" : "text-muted-foreground",
          translationEnabled && "opacity-90"
        )}
      >
        {highlightedText ? (
          highlightedText.highlightedParts.map((part, partIndex) => {
            const isSearchMatch = 'isSearchMatch' in part && part.isSearchMatch;
            const isCurrentSearchMatch = 'isCurrentSearchMatch' in part && part.isCurrentSearchMatch;
            const isCitation = 'isCitation' in part && part.isCitation;

            let style = undefined;
            if (part.highlighted) {
              if (isSearchMatch) {
                style = {
                  backgroundColor: isCurrentSearchMatch ? 'hsl(40, 100%, 50%)' : 'hsl(48, 100%, 80%)',
                  color: isCurrentSearchMatch ? 'white' : 'black',
                  padding: '0 1px',
                  borderRadius: '2px',
                };
              } else if (isCitation || selectedTopic?.isCitationReel) {
                style = {
                  backgroundColor: 'hsl(48, 100%, 85%)',
                  padding: '1px 3px',
                  borderRadius: '3px',
                  boxShadow: '0 0 0 1px hsl(48, 100%, 50%, 0.3)',
                };
              } else if (selectedTopicColor) {
                style = {
                  backgroundColor: `hsl(${selectedTopicColor} / 0.2)`,
                  padding: '0 2px',
                  borderRadius: '2px',
                };
              }
            }

            return (
              <span
                key={partIndex}
                className={part.highlighted ? "text-foreground" : ""}
                style={style}
              >
                {part.text}
              </span>
            );
          })
        ) : (
          segment.text
        )}
      </p>

      {/* Translated text */}
      {translationEnabled && (
        <div className="flex items-start gap-2">
          <p
            className={cn(
              "text-sm leading-relaxed flex-1",
              isCurrent ? "text-foreground font-medium" : "text-muted-foreground"
            )}
          >
            {isLoadingTranslation ? (
              <span className="text-muted-foreground italic">Translating...</span>
            ) : hasTranslationError ? (
              <span className="text-red-500/70 italic text-xs">Translation failed</span>
            ) : translation ? (
              translation
            ) : (
              <span className="text-muted-foreground/50 italic">Translation pending...</span>
            )}
          </p>
          {hasTranslationError && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRequestTranslation(index);
              }}
              className="text-xs text-blue-500 hover:text-blue-600 underline shrink-0"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export const TranscriptSegmentItem = memo(TranscriptSegmentItemComponent);
