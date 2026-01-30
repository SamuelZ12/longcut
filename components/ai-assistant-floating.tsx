"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MessageSquare, X, Minimize2, Maximize2, Pin, PinOff, GripVertical } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AIChat } from "@/components/ai-chat";
import { AIProviderSelector } from "@/components/ai-provider-selector";
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

  // Prevent closing when pinned - wrapper function
  const handleOpenChangeWrapper = (newOpen: boolean) => {
    // If trying to close while pinned, ignore it
    if (!newOpen && isPinned) {
      return;
    }
    handleOpenChange(newOpen);
  };
  const [isMaximized, setIsMaximized] = useState(false);

  // Draggable state
  const [isPinned, setIsPinned] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const dragStartMousePos = useRef({ x: 0, y: 0 });
  const dialogRef = useRef<HTMLDivElement>(null);

  // Load saved position on mount
  useEffect(() => {
    const savedPosition = localStorage.getItem('ai-assistant-position');
    const savedPinned = localStorage.getItem('ai-assistant-pinned');
    if (savedPosition) {
      setPosition(JSON.parse(savedPosition));
    }
    if (savedPinned) {
      setIsPinned(JSON.parse(savedPinned));
    }
  }, []);

  // Save position to localStorage
  useEffect(() => {
    if (isPinned) {
      localStorage.setItem('ai-assistant-position', JSON.stringify(position));
      localStorage.setItem('ai-assistant-pinned', JSON.stringify(isPinned));
    } else {
      localStorage.removeItem('ai-assistant-position');
      localStorage.removeItem('ai-assistant-pinned');
    }
  }, [position, isPinned]);

  // Drag handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isPinned) return;
    setIsDragging(true);
    dragStartPos.current = { ...position };
    dragStartMousePos.current = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !isPinned) return;

      const deltaX = e.clientX - dragStartMousePos.current.x;
      const deltaY = e.clientY - dragStartMousePos.current.y;

      const newX = dragStartPos.current.x + deltaX;
      const newY = dragStartPos.current.y + deltaY;

      // Constrain to viewport
      const maxX = window.innerWidth - 100;
      const maxY = window.innerHeight - 100;

      setPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, isPinned]);

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

      {/* Custom Draggable Dialog */}
      <DialogPrimitive.Root open={isOpen} onOpenChange={handleOpenChangeWrapper} modal={false}>
        <DialogPrimitive.Portal>
          {/* Only show overlay when not pinned */}
          {!isPinned && (
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          )}

          <DialogPrimitive.Content
            ref={dialogRef}
            className={cn(
              "z-50 bg-background shadow-lg rounded-lg border",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
              "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
              "duration-200",
              isMaximized
                ? "max-w-[90vw] w-[90vw] max-h-[90vh] h-[90vh]"
                : "max-w-lg w-full max-h-[70vh] h-[70vh]",
              "flex flex-col overflow-hidden",
              isPinned && "shadow-2xl",
              isDragging && "cursor-grabbing",
            )}
            style={
              isPinned
                ? {
                    position: 'fixed',
                    left: `${position.x}px`,
                    top: `${position.y}px`,
                    transform: 'none',
                    margin: 0,
                  }
                : {
                    position: 'fixed',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                  }
            }
          >
            {/* Header */}
            <div
              className={cn(
                "flex items-center justify-between p-4 border-b shrink-0",
                isPinned && "cursor-grab active:cursor-grabbing"
              )}
              onMouseDown={handleMouseDown}
            >
              <div className="flex items-center gap-2">
                {isPinned && <GripVertical className="h-4 w-4 text-muted-foreground" />}
                <DialogPrimitive.Title className="flex items-center gap-2 font-semibold">
                  <MessageSquare className="h-5 w-5" />
                  AI 助手
                </DialogPrimitive.Title>
                <AIProviderSelector />
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setIsPinned(!isPinned)}
                  title={isPinned ? "取消固定" : "固定位置"}
                >
                  {isPinned ? (
                    <PinOff className="h-4 w-4" />
                  ) : (
                    <Pin className="h-4 w-4" />
                  )}
                </Button>
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
                <DialogPrimitive.Close asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title="关闭"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </DialogPrimitive.Close>
              </div>
            </div>

            {/* Content */}
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
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
