"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, ArrowUp, Link, Sparkles, X } from "lucide-react";
import { extractVideoId } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ModeSelector } from "@/components/mode-selector";
import { isGrokProviderOnClient } from "@/lib/ai-providers/client-config";
import type { TopicGenerationMode } from "@/lib/types";

interface UrlInputProps {
  onSubmit: (url: string) => void;
  isLoading?: boolean;
  mode?: TopicGenerationMode;
  onModeChange?: (mode: TopicGenerationMode) => void;
  onFeelingLucky?: () => void | Promise<void>;
  isFeelingLucky?: boolean;
}

export function UrlInput({
  onSubmit,
  isLoading = false,
  mode,
  onModeChange,
  onFeelingLucky,
  isFeelingLucky = false,
}: UrlInputProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isValidUrl, setIsValidUrl] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const forceSmartMode = isGrokProviderOnClient();
  const showModeSelector =
    !forceSmartMode && typeof onModeChange === "function";
  const showFeelingLucky = typeof onFeelingLucky === "function";
  const modeValue: TopicGenerationMode = forceSmartMode
    ? "smart"
    : mode ?? "fast";

  // Validate URL in real-time
  useEffect(() => {
    if (!url.trim()) {
      setIsValidUrl(false);
      return;
    }

    const videoId = extractVideoId(url);
    setIsValidUrl(!!videoId);
  }, [url]);

  const handleClear = () => {
    setUrl("");
    setIsValidUrl(false);
    setError("");
    inputRef.current?.focus();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!url.trim()) {
      setError("Please enter a YouTube URL");
      return;
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      setError("Please enter a valid YouTube URL");
      return;
    }

    onSubmit(url);
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-[615px]">
      <div className="flex flex-col gap-2">
        <Card
          className={cn(
            "relative flex flex-col items-start gap-6 self-stretch rounded-[22px] border border-[#f0f1f1] bg-white px-6 pt-6 pb-3 shadow-[2px_11px_40.4px_rgba(0,0,0,0.06)] transition-shadow",
            isFocused && "shadow-[2px_11px_40.4px_rgba(0,0,0,0.1)]",
            error && "ring-2 ring-destructive"
          )}
        >
          {/* Top row: Input field only */}
          <div className="flex w-full items-center gap-2.5">
            <div className="w-5 flex items-center justify-end shrink-0">
              <Link className="h-5 w-5 text-[#989999]" strokeWidth={1.8} />
            </div>
            <input
              ref={inputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="Paste Youtube URL link here..."
              aria-label="YouTube URL"
              aria-invalid={!!error}
              aria-describedby={error ? "url-error" : undefined}
              className="flex-1 border-0 bg-transparent text-[14px] text-[#989999] placeholder:text-[#989999] focus:outline-none"
              disabled={isLoading}
            />
            {url && !isLoading && (
              <button
                type="button"
                onClick={handleClear}
                className="text-[#989999] hover:text-[#5c5c5c] focus:outline-none transition-colors"
                aria-label="Clear URL"
              >
                <X className="h-5 w-5" strokeWidth={1.8} />
              </button>
            )}
          </div>

          {/* Bottom row: Mode selector (left) and actions (right) */}
          <div className="flex w-full flex-wrap items-center gap-3">
            {showModeSelector && <ModeSelector value={modeValue} onChange={onModeChange} />}
            <div className="ml-auto flex items-center gap-2">
              {showFeelingLucky && (
                <Button
                  type="button"
                  variant="pill"
                  size="sm"
                  disabled={isFeelingLucky || isLoading}
                  onClick={() => {
                    if (isFeelingLucky || isLoading) return;
                    void onFeelingLucky?.();
                  }}
                  className={cn(
                    "h-7 rounded-full border border-[#efefef] bg-white px-3 text-[12px] font-semibold text-[#b3b4b4] shadow-none hover:bg-[#f7f7f7] disabled:bg-[#f5f5f5] disabled:text-[#a7a7a7]",
                    isFeelingLucky && "cursor-wait"
                  )}
                >
                  {isFeelingLucky ? (
                    <>
                      <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                      Feeling lucky...
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-1.5 h-3 w-3" />
                      I&apos;m feeling lucky
                    </>
                  )}
                </Button>
              )}
              <Button
                type="submit"
                aria-label={isLoading ? "Analyzing..." : "Analyze video"}
                disabled={isLoading || !url.trim()}
                size="icon"
                className={cn(
                  "h-7 w-7 shrink-0 rounded-full text-white transition-colors",
                  isValidUrl
                    ? "bg-black hover:bg-black/80"
                    : "bg-[#B3B4B4] hover:bg-[#9d9e9e]",
                  "disabled:bg-[#B3B4B4] disabled:text-white disabled:opacity-100"
                )}
              >
                {isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        </Card>
        {error && (
          <p id="url-error" role="alert" className="text-xs text-destructive px-1">{error}</p>
        )}
      </div>
    </form>
  );
}
