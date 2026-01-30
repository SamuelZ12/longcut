"use client";

import { useEffect, useState } from "react";
import { Loader2, ArrowUp, Link as LinkIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { extractVideoId } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ModeSelector } from "@/components/mode-selector";
import { isGrokProviderOnClient } from "@/lib/ai-providers/client-config";
import type { TopicGenerationMode } from "@/lib/types";

interface UrlInputWithBrandingProps {
  onSubmit: (url: string) => void;
  isLoading?: boolean;
  initialUrl?: string;
  mode?: TopicGenerationMode;
  onModeChange?: (mode: TopicGenerationMode) => void;
}

export function UrlInputWithBranding({ onSubmit, isLoading = false, initialUrl, mode, onModeChange }: UrlInputWithBrandingProps) {
  const [url, setUrl] = useState(() => initialUrl ?? "");
  const [error, setError] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const forceSmartMode = isGrokProviderOnClient();
  const showModeSelector =
    !forceSmartMode && typeof onModeChange === "function";
  const modeValue: TopicGenerationMode = forceSmartMode
    ? "smart"
    : mode ?? "fast";

  useEffect(() => {
    if (initialUrl === undefined) return;
    setUrl((current) => (current === initialUrl ? current : initialUrl));
  }, [initialUrl]);

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
    <div className="w-full max-w-[615px]">
      <div className="flex flex-col gap-2">
        <Card
          className={cn(
            "relative flex flex-col items-start gap-6 self-stretch rounded-[22px] border border-[#f0f1f1] bg-white p-6 shadow-[2px_11px_40.4px_rgba(0,0,0,0.06)] transition-shadow",
            isFocused && "shadow-[2px_11px_40.4px_rgba(0,0,0,0.1)]",
            error && "ring-2 ring-destructive"
          )}
        >
          {/* Top row: Branding + Input field only */}
          <form onSubmit={handleSubmit} className="flex w-full items-center gap-3.5">
            {/* Left: Little universe Logo and Text */}
            <Link
              href="/"
              className="flex items-center gap-2.5 shrink-0 border-0 bg-transparent p-0 text-left outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              aria-label="Go to Little universe home"
            >
              <Image
                src="/Video_Play.svg"
                alt="Little universe logo"
                width={29}
                height={29}
                className="h-7 w-7"
                priority
              />
              <p className="text-sm font-semibold text-slate-800">Little universe</p>
            </Link>

            {/* Vertical Separator */}
            <div className="h-6 w-px bg-[#e5e7eb] shrink-0" />

            {/* Middle: Input Field */}
            <div className="flex flex-1 items-center gap-2.5 min-w-0">
              <div className="w-5 flex items-center justify-end shrink-0">
                <LinkIcon className="h-5 w-5 text-[#989999]" strokeWidth={1.8} />
              </div>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onFocus={() => {
                  setIsFocused(true);
                }}
                onBlur={() => {
                  setIsFocused(false);
                }}
                placeholder="Paste Youtube URL link here..."
                aria-label="YouTube URL"
                aria-invalid={!!error}
                aria-describedby={error ? "url-error" : undefined}
                className="flex-1 border-0 bg-transparent text-[14px] text-[#989999] placeholder:text-[#989999] focus:outline-none min-w-0"
              />
            </div>
          </form>

          {/* Bottom row: Mode selector (left) and submit button (right) */}
          <div
            className={cn(
              "flex w-full items-center gap-3",
              showModeSelector ? "justify-between" : "justify-end"
            )}
          >
            {showModeSelector && (
              <ModeSelector value={modeValue} onChange={onModeChange} />
            )}
            <Button
              type="submit"
              onClick={handleSubmit}
              aria-label={isLoading ? "Analyzing..." : "Analyze video"}
              disabled={isLoading || !url.trim()}
              size="icon"
              className="h-7 w-7 shrink-0 rounded-full bg-[#B3B4B4] text-white hover:bg-[#9d9e9e] disabled:bg-[#B3B4B4] disabled:text-white disabled:opacity-100"
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </Card>
        {error && (
          <p id="url-error" role="alert" className="text-xs text-destructive px-1">{error}</p>
        )}
      </div>
    </div>
  );
}
