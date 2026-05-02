"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { NoteMetadata } from "@/lib/types";
import { enhanceNoteQuote } from "@/lib/notes-client";
import { toast } from "sonner";
import { Send, Sparkles, Loader2, RotateCcw, Check, Clock } from "lucide-react";
import { formatDuration } from "@/lib/utils";

interface NoteEditorProps {
  selectedText: string;
  metadata?: NoteMetadata | null;
  currentTime?: number;
  onSave: (payload: { noteText: string; selectedText: string; metadata?: NoteMetadata }) => void;
  onCancel: () => void;
}

export function NoteEditor({ selectedText, metadata, currentTime, onSave }: NoteEditorProps) {
  const [originalQuote, setOriginalQuote] = useState(selectedText.trim());
  const [quoteText, setQuoteText] = useState(selectedText.trim());
  const [additionalText, setAdditionalText] = useState("");
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [hasEnhanced, setHasEnhanced] = useState(false);
  const [capturedTimestamp, setCapturedTimestamp] = useState<number | null>(null);

  useEffect(() => {
    const trimmed = selectedText.trim();
    setOriginalQuote(trimmed);
    setQuoteText(trimmed);
    setHasEnhanced(false);
    setAdditionalText("");
    setCapturedTimestamp(null);
  }, [selectedText]);

  const handleCaptureTimestamp = useCallback(() => {
    if (currentTime !== undefined) {
      setCapturedTimestamp(currentTime);
    }
  }, [currentTime]);

  const handleSave = useCallback(() => {
    const baseQuote = (quoteText || originalQuote).trim();
    const noteParts: string[] = [];

    if (baseQuote.length > 0) {
      noteParts.push(baseQuote);
    }

    if (additionalText.trim().length > 0) {
      noteParts.push(additionalText.trim());
    }

    if (noteParts.length === 0) {
      toast.error("Nothing to save yet");
      return;
    }

    // Merge metadata
    let finalMetadata: NoteMetadata | undefined = metadata ? { ...metadata } : undefined;

    if (capturedTimestamp !== null) {
      finalMetadata = {
        ...(finalMetadata || {}),
        transcript: {
          ...(finalMetadata?.transcript || {}),
          start: capturedTimestamp,
        },
        timestampLabel: formatDuration(capturedTimestamp),
      };
    }

    onSave({
      noteText: noteParts.join("\n\n"),
      selectedText: baseQuote || originalQuote,
      metadata: finalMetadata
    });
  }, [additionalText, onSave, originalQuote, quoteText, metadata, capturedTimestamp]);

  const handleEnhance = useCallback(async () => {
    if (isEnhancing || !quoteText.trim()) {
      return;
    }

    setIsEnhancing(true);
    try {
      const cleaned = await enhanceNoteQuote(quoteText.trim());
      setQuoteText(cleaned);
      setHasEnhanced(true);
      toast.success("Selected text cleaned");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to enhance note";
      toast.error(message);
    } finally {
      setIsEnhancing(false);
    }
  }, [isEnhancing, quoteText]);

  const handleResetQuote = useCallback(() => {
    setQuoteText(originalQuote);
    setHasEnhanced(false);
  }, [originalQuote]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSave();
    }
  };

  const hasQuote = quoteText.length > 0;
  const enhancementDisabled = isEnhancing || !quoteText.trim();

  return (
    <div className="relative rounded-xl bg-neutral-100 border border-[#ebecee] p-4 animate-in fade-in duration-200 w-full max-w-full">
      {hasQuote && (
        <>
          <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.17em] text-muted-foreground/80 mb-1">
            <span>Selected Snippet</span>
            {hasEnhanced && !isEnhancing && (
              <span className="flex items-center gap-1 text-emerald-600 font-medium normal-case tracking-[0.05em]">
                <Check className="w-3 h-3" />
                Cleaned
              </span>
            )}
          </div>

          <div className="border-l-2 border-primary/40 bg-white/60 pl-3 pr-3 py-2 mb-3">
            <Textarea
              value={quoteText}
              onChange={(e) => setQuoteText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Edit the snippet before saving"
              className="resize-none border-none bg-transparent px-1 py-0 text-sm text-foreground/90 leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-none whitespace-pre-wrap break-words min-h-[72px]"
              aria-label="Selected snippet editor"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleEnhance}
              disabled={enhancementDisabled}
              className="h-7 rounded-full px-3 text-xs border-dashed border-slate-300 bg-white/50 text-slate-600 hover:bg-white hover:text-slate-900"
            >
              {isEnhancing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                  Enhancing…
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                  Enhance with AI
                </>
              )}
            </Button>
            {hasEnhanced ? (
              <button
                type="button"
                onClick={handleResetQuote}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Reset to original
              </button>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                Removes filler words & typos
              </span>
            )}
          </div>
        </>
      )}

      {hasQuote && (
         <div className="text-[11px] uppercase tracking-[0.17em] text-muted-foreground/80 mb-1 mt-4">
            Your Note
         </div>
      )}

      <Textarea
        value={additionalText}
        onChange={(e) => setAdditionalText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={hasQuote ? "Add context or your own takeaway (optional)" : "Write a note..."}
        className="resize-none text-xs bg-transparent border-none focus-visible:ring-0 focus-visible:ring-offset-0 pr-12 min-h-[90px] px-2 py-2 max-w-full"
        rows={4}
        autoFocus={!hasQuote}
      />

      <div className="flex items-center justify-between mt-2">
         <Button
           type="button"
           variant="ghost"
           size="sm"
           onClick={handleCaptureTimestamp}
           className="text-xs text-muted-foreground hover:text-primary gap-1 px-2 h-7"
         >
            <Clock className="w-3.5 h-3.5" />
            {capturedTimestamp !== null
              ? `Timestamp: ${formatDuration(capturedTimestamp)}`
              : (metadata?.timestampLabel ? `Timestamp: ${metadata.timestampLabel}` : "Capture Timestamp")}
         </Button>

         <Button
            type="button"
            onClick={handleSave}
            size="icon"
            className="rounded-full h-8 w-8 ml-auto"
         >
            <Send className="w-3.5 h-3.5" />
         </Button>
      </div>
    </div>
  );
}
