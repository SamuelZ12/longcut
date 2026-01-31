"use client";

import { useState, useImperativeHandle, forwardRef } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { TranscriptViewer } from "@/components/transcript-viewer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Languages, PenLine, Columns2, LayoutList } from "lucide-react";
import {
  TranscriptSegment,
  Topic,
  Citation,
  Note,
  NoteSource,
  NoteMetadata,
  VideoInfo,
  TranslationRequestHandler,
} from "@/lib/types";
import { SelectionActionPayload } from "@/components/selection-actions";
import { NotesPanel, EditingNote } from "@/components/notes-panel";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LanguageSelector } from "@/components/language-selector";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const translationSelectorEnabled = (() => {
  const raw = process.env.NEXT_PUBLIC_ENABLE_TRANSLATION_SELECTOR;
  if (!raw) {
    return false;
  }
  const normalized = raw.toLowerCase();
  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  );
})();

type ViewMode = "tabs" | "split";

interface RightColumnPanelProps {
  transcript: TranscriptSegment[];
  selectedTopic: Topic | null;
  onTimestampClick: (
    seconds: number,
    endSeconds?: number,
    isCitation?: boolean,
    citationText?: string,
    isWithinHighlightReel?: boolean,
    isWithinCitationHighlight?: boolean,
  ) => void;
  currentTime?: number;
  topics?: Topic[];
  citationHighlight?: Citation | null;
  videoId: string;
  videoTitle?: string;
  videoInfo?: VideoInfo | null;
  onCitationClick: (citation: Citation) => void;
  notes?: Note[];
  onSaveNote?: (payload: {
    text: string;
    source: NoteSource;
    sourceId?: string | null;
    metadata?: NoteMetadata | null;
  }) => Promise<void>;
  onTakeNoteFromSelection?: (payload: SelectionActionPayload) => void;
  editingNote?: EditingNote | null;
  onSaveEditingNote?: (payload: {
    noteText: string;
    selectedText: string;
    metadata?: NoteMetadata;
  }) => void;
  onCancelEditing?: () => void;
  onEditNote?: (note: Note) => void;
  isAuthenticated?: boolean;
  onRequestSignIn?: () => void;
  selectedLanguage?: string | null;
  translationCache?: Map<string, string>;
  onRequestTranslation?: TranslationRequestHandler;
  onLanguageChange?: (languageCode: string | null) => void;
  availableLanguages?: string[];
  currentSourceLanguage?: string;
  onRequestExport?: () => void;
  exportButtonState?: {
    tooltip?: string;
    disabled?: boolean;
    badgeLabel?: string;
    isLoading?: boolean;
  };
  onAddNote?: () => void;
}

export interface RightColumnPanelHandle {
  switchToTranscript: () => void;
  switchToNotes: () => void;
  setViewMode: (mode: ViewMode) => void;
}

export const RightColumnPanel = forwardRef<
  RightColumnPanelHandle,
  RightColumnPanelProps
>(
  (
    {
      transcript,
      selectedTopic,
      onTimestampClick,
      currentTime,
      topics,
      citationHighlight,
      videoId,
      videoTitle,
      videoInfo,
      onCitationClick,
      notes,
      onSaveNote,
      onTakeNoteFromSelection,
      editingNote,
      onSaveEditingNote,
      onCancelEditing,
      onEditNote,
      isAuthenticated,
      onRequestSignIn,
      selectedLanguage = null,
      translationCache,
      onRequestTranslation,
      onLanguageChange,
      availableLanguages,
      currentSourceLanguage,
      onRequestExport,
      exportButtonState,
      onAddNote,
    },
    ref,
  ) => {
    const [viewMode, setViewMode] = useState<ViewMode>("tabs");
    const [activeTab, setActiveTab] = useState<"transcript" | "notes">(
      "transcript",
    );
    const showTranslationSelector = translationSelectorEnabled;

    // Expose methods to parent
    useImperativeHandle(ref, () => ({
      switchToTranscript: () => {
        setActiveTab("transcript");
      },
      switchToNotes: () => {
        setActiveTab("notes");
      },
      setViewMode: (mode: ViewMode) => {
        setViewMode(mode);
      },
    }));

    // Transcript component (reused in both modes)
    const transcriptComponent = (
      <TranscriptViewer
        transcript={transcript}
        selectedTopic={selectedTopic}
        onTimestampClick={onTimestampClick}
        currentTime={currentTime}
        topics={topics}
        citationHighlight={citationHighlight}
        onTakeNoteFromSelection={onTakeNoteFromSelection}
        videoId={videoId}
        selectedLanguage={selectedLanguage}
        onRequestTranslation={onRequestTranslation}
        onRequestExport={onRequestExport}
        exportButtonState={exportButtonState}
      />
    );

    // Notes component (reused in both modes)
    const notesComponent = (
      <TooltipProvider delayDuration={0}>
        <NotesPanel
          notes={notes}
          editingNote={editingNote}
          onSaveEditingNote={onSaveEditingNote}
          onCancelEditing={onCancelEditing}
          onEditNote={onEditNote}
          isAuthenticated={isAuthenticated}
          onSignInClick={onRequestSignIn}
          currentTime={currentTime}
          onTimestampClick={onTimestampClick}
          onAddNote={onAddNote}
videoInfo={videoInfo ? {
            youtubeId: videoId,
            title: videoInfo.title,
            author: videoInfo.author,
            duration: videoInfo.duration ?? undefined,
            description: videoInfo.description,
            thumbnailUrl: videoInfo.thumbnail
          } : null}
          topics={topics}
        />
      </TooltipProvider>
    );

    return (
      <Card className="h-full flex flex-col overflow-hidden p-0 gap-0 border-0">
        {/* Header with mode toggle */}
        <div className="flex items-center gap-2 p-2 rounded-t-3xl border-b">
          <div className="flex-1">
            {showTranslationSelector ? (
              <LanguageSelector
                activeTab={activeTab}
                selectedLanguage={selectedLanguage}
                availableLanguages={availableLanguages}
                currentSourceLanguage={currentSourceLanguage}
                isAuthenticated={isAuthenticated}
                onTabSwitch={(tab) => {
                  if (tab === "transcript" || tab === "notes") {
                    setActiveTab(tab);
                  }
                }}
                onLanguageChange={onLanguageChange}
                onRequestSignIn={onRequestSignIn}
              />
            ) : (
              <div
                className={cn(
                  "flex items-center gap-0 rounded-2xl",
                  viewMode === "tabs" && activeTab === "transcript"
                    ? "bg-neutral-100"
                    : "hover:bg-white/50",
                )}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setActiveTab("transcript")}
                  className={cn(
                    "flex-1 justify-center gap-2 rounded-2xl border-0",
                    viewMode === "tabs" && activeTab === "transcript"
                      ? "text-foreground hover:bg-neutral-100"
                      : "text-muted-foreground hover:text-foreground hover:bg-transparent",
                  )}
                >
                  <Languages className="h-4 w-4" />
                  字幕
                </Button>
              </div>
            )}
          </div>

          {/* Notes tab button (only in tabs mode) */}
          {viewMode === "tabs" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveTab("notes")}
              className={cn(
                "flex-1 justify-center gap-2 rounded-2xl",
                activeTab === "notes"
                  ? "bg-neutral-100 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/50",
                !notes?.length && "opacity-75",
              )}
            >
              <PenLine className="h-4 w-4" />
              笔记
            </Button>
          )}

          {/* View mode toggle */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setViewMode(viewMode === "tabs" ? "split" : "tabs")
                  }
                  className={cn(
                    "h-8 w-8 shrink-0",
                    viewMode === "split" && "bg-neutral-100",
                  )}
                >
                  {viewMode === "split" ? (
                    <LayoutList className="h-4 w-4" />
                  ) : (
                    <Columns2 className="h-4 w-4 rotate-90" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {viewMode === "split" ? "切换到标签模式" : "切换到分屏模式"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-hidden relative">
          {viewMode === "split" ? (
            /* Split mode: Transcript on top, Notes on bottom with resizable divider */
            <ResizablePanelGroup direction="vertical" className="h-full">
              <ResizablePanel defaultSize={60} minSize={20}>
                <div className="h-full overflow-hidden">
                  {transcriptComponent}
                </div>
              </ResizablePanel>
              <ResizableHandle
                withHandle
                className="bg-border hover:bg-primary/20 transition-colors"
              />
              <ResizablePanel defaultSize={40} minSize={20}>
                <div className="h-full overflow-hidden border-t">
                  <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                    <PenLine className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">笔记</span>
                  </div>
                  <div className="h-[calc(100%-2.5rem)] overflow-hidden">
                    {notesComponent}
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            /* Tabs mode: Show one at a time */
            <>
              <div
                className={cn(
                  "absolute inset-0",
                  activeTab !== "transcript" && "hidden",
                )}
              >
                {transcriptComponent}
              </div>
              <div
                className={cn(
                  "absolute inset-0",
                  activeTab !== "notes" && "hidden",
                )}
              >
                {notesComponent}
              </div>
            </>
          )}
        </div>
      </Card>
    );
  },
);

RightColumnPanel.displayName = "RightColumnPanel";
