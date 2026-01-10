"use client";

import { useState } from "react";
import { ArrowRight, Crown, Mic, Clock, AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface TranscriptionPromptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerate: () => void;
  onUpgrade?: () => void;
  scenario: "no-captions" | "user-choice" | "credits-exhausted" | "not-pro";
  isLoading?: boolean;
  usage?: {
    subscriptionMinutes: {
      used: number;
      limit: number;
      remaining: number;
    };
    topupMinutes: number;
    totalRemaining: number;
    resetAt?: string;
  };
  videoDurationMinutes?: number;
  estimatedWaitSeconds?: number;
}

const PRO_PERKS = [
  "120 min/month AI transcription",
  "100 videos/month analysis",
  "All export features",
];

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "less than a minute";
  if (minutes === 1) return "~1 minute";
  return `~${minutes} minutes`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (remainingMins === 0) return `${hours}h`;
  return `${hours}h ${remainingMins}m`;
}

export function TranscriptionPrompt({
  open,
  onOpenChange,
  onGenerate,
  onUpgrade,
  scenario,
  isLoading = false,
  usage,
  videoDurationMinutes = 0,
  estimatedWaitSeconds = 0,
}: TranscriptionPromptProps) {
  const totalRemaining = usage?.totalRemaining ?? 0;
  const hasEnoughCredits = totalRemaining >= videoDurationMinutes;

  // Scenario: Not a Pro user
  if (scenario === "not-pro") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="space-y-1.5">
            <Badge className="w-fit gap-1 bg-amber-500/15 text-amber-700">
              <Crown className="h-3.5 w-3.5" />
              Pro Feature
            </Badge>
            <DialogTitle className="text-xl font-semibold">
              AI Transcription is a Pro Feature
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Get accurate AI-powered transcripts for any video, even when YouTube captions are unavailable.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-2xl border border-muted bg-muted/50 p-4">
            <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
              What&apos;s included with Pro
            </p>
            <Separator className="my-3" />
            <ul className="space-y-2 text-sm text-foreground">
              {PRO_PERKS.map((perk) => (
                <li key={perk} className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
                  <span>{perk}</span>
                </li>
              ))}
            </ul>
          </div>

          <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              className="w-full sm:w-auto"
              onClick={() => onOpenChange(false)}
            >
              Maybe later
            </Button>
            <Button className="w-full sm:w-auto" onClick={onUpgrade}>
              Upgrade to Pro
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Scenario: Credits exhausted
  if (scenario === "credits-exhausted" || !hasEnoughCredits) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="space-y-1.5">
            <Badge className="w-fit gap-1 bg-orange-500/15 text-orange-700">
              <AlertCircle className="h-3.5 w-3.5" />
              Credits Low
            </Badge>
            <DialogTitle className="text-xl font-semibold">
              Transcription Minutes Used Up
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {usage?.resetAt
                ? `You've used all ${usage.subscriptionMinutes.limit} minutes this month. Your credits reset ${usage.resetAt}.`
                : "You don't have enough transcription minutes for this video."}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-2xl border border-muted bg-muted/50 p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">This video requires</span>
              <span className="font-medium">{formatMinutes(videoDurationMinutes)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Your remaining credits</span>
              <span className="font-medium text-orange-600">{formatMinutes(totalRemaining)}</span>
            </div>
          </div>

          <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              className="w-full sm:w-auto"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button className="w-full sm:w-auto" onClick={onUpgrade}>
              Buy 120 more minutes - $2.99
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Scenario: No captions available (auto-prompt)
  if (scenario === "no-captions") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="space-y-1.5">
            <Badge className="w-fit gap-1 bg-blue-500/15 text-blue-700">
              <Mic className="h-3.5 w-3.5" />
              AI Transcription
            </Badge>
            <DialogTitle className="text-xl font-semibold">
              No Captions Available
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              This video doesn&apos;t have YouTube captions. Generate an AI transcript to analyze this video.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-2xl border border-muted bg-muted/50 p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Credits remaining</span>
              <span className="font-medium">{formatMinutes(totalRemaining)}</span>
            </div>
            {estimatedWaitSeconds > 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span>Est. wait: {formatDuration(estimatedWaitSeconds)}</span>
              </div>
            )}
          </div>

          <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              className="w-full sm:w-auto"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              className="w-full sm:w-auto"
              onClick={onGenerate}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Starting...
                </>
              ) : (
                <>
                  Generate AI Transcript
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Scenario: User choice (has YouTube captions but wants AI)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="space-y-1.5">
          <Badge className="w-fit gap-1 bg-blue-500/15 text-blue-700">
            <Mic className="h-3.5 w-3.5" />
            AI Transcription
          </Badge>
          <DialogTitle className="text-xl font-semibold">
            Use AI Transcription?
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            AI transcription is more accurate than YouTube captions, especially for accents and technical terms.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-2xl border border-muted bg-muted/50 p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Credits remaining</span>
            <span className="font-medium">{formatMinutes(totalRemaining)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">This video</span>
            <span className="font-medium">{formatMinutes(videoDurationMinutes)}</span>
          </div>
          {estimatedWaitSeconds > 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span>Est. processing time: {formatDuration(estimatedWaitSeconds)}</span>
            </div>
          )}
        </div>

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Keep YouTube
          </Button>
          <Button
            className="w-full sm:w-auto"
            onClick={onGenerate}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Starting...
              </>
            ) : (
              <>
                Generate
                <ArrowRight className="ml-1.5 h-4 w-4" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
