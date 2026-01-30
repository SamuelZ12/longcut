"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MessageSquare, X, Minimize2, Maximize2 } from "lucide-react";
import { AIChat } from "@/components/ai-chat";
import { cn } from "@/lib/utils";
import {
  TranscriptSegment,
  Topic,
  Citation,
  NoteSource,
  NoteMetadata,
  VideoInfo,
  TranslationRequestHandler,
} from "@/lib/types";
import { SelectionActionPayload } from "@/components/selection-actions";

interface AIAssistantFloatingProps {
  transcript: TranscriptSegment[];
  topics: Topic[];
  videoId: string;
  videoTitle?: string;
  videoInfo?: VideoInfo | null;
  onCitationClick: (citation: Citation) => void;
  onTimestampClick: (
    seconds: number,
    endSeconds?: number,
    isCitation?: boolean,
    citationText?: string,
  ) => void;
  cachedSuggestedQuestions?: string[] | null;
  onSaveNote?: (payload: {
    text: string;
    source: NoteSource;
    sourceId?: string | null;
    metadata?: NoteMetadata | null;
  }) => Promise<void>;
  onTakeNoteFromSelection?: (payload: SelectionActionPayload) => void;
  selectedLanguage?: string | null;
  translationCache?: Map<string, string>;
  onRequestTranslation?: TranslationRequestHandler;
  isAuthenticated?: boolean;
  onRequestSignIn?: () => void;
  // External control props
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function AIAssistantFloating({
  transcript,
  topics,
  videoId,
  videoTitle,
  videoInfo,
  onCitationClick,
  onTimestampClick,
  cachedSuggestedQuestions,
  onSaveNote,
  onTakeNoteFromSelection,
  selectedLanguage,
  translationCache,
  onRequestTranslation,
  isAuthenticated,
  onRequestSignIn,
  open,
  onOpenChange,
}: AIAssistantFloatingProps) {
  // Use internal state if not controlled externally
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open !== undefined ? open : internalOpen;
  const handleOpenChange = onOpenChange || setInternalOpen;
  const [isMaximized, setIsMaximized] = useState(false);

  return (
    <>
      {/* Floating Action Button */}
      <Button
        onClick={() => handleOpenChange(true)}
        className={cn(
          "fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full shadow-lg",
          "bg-primary hover:bg-primary/90 text-primary-foreground",
          "transition-all duration-200 hover:scale-105",
          isOpen && "hidden",
        )}
        size="icon"
        title="AI 助手"
      >
        <MessageSquare className="h-6 w-6" />
      </Button>

      {/* Dialog for AI Chat */}
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent
          className={cn(
            "p-0 gap-0 flex flex-col",
            isMaximized
              ? "max-w-[90vw] w-[90vw] max-h-[90vh] h-[90vh]"
              : "max-w-lg w-full max-h-[70vh] h-[70vh]",
          )}
        >
          <DialogHeader className="flex flex-row items-center justify-between p-4 border-b shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              AI 助手
            </DialogTitle>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setIsMaximized(!isMaximized)}
                title={isMaximized ? "还原" : "最大化"}
              >
                {isMaximized ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => handleOpenChange(false)}
                title="关闭"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            <AIChat
              transcript={transcript}
              topics={topics}
              videoId={videoId}
              videoTitle={videoTitle}
              videoInfo={videoInfo}
              onCitationClick={onCitationClick}
              onTimestampClick={onTimestampClick}
              cachedSuggestedQuestions={cachedSuggestedQuestions}
              onSaveNote={onSaveNote}
              onTakeNoteFromSelection={onTakeNoteFromSelection}
              selectedLanguage={selectedLanguage}
              translationCache={translationCache}
              onRequestTranslation={onRequestTranslation}
              isAuthenticated={isAuthenticated}
              onRequestSignIn={onRequestSignIn}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
