"use client";

import { useState, useEffect, useCallback } from "react";
import { Mic, CheckCircle, XCircle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import type { TranscriptSegment } from "@/lib/types";

interface TranscriptionProgressProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  onComplete: (transcriptData: TranscriptSegment[]) => void;
  onCancel?: () => void;
  onError?: (error: string) => void;
}

type JobStatus =
  | "pending"
  | "downloading"
  | "transcribing"
  | "completed"
  | "failed"
  | "cancelled";

interface JobStatusResponse {
  success: boolean;
  status: JobStatus;
  progress: number;
  currentStage?: string;
  transcriptData?: TranscriptSegment[];
  errorMessage?: string;
  totalChunks?: number;
  completedChunks?: number;
}

const POLL_INTERVAL_MS = 2000; // Poll every 2 seconds

function getStageLabel(status: JobStatus, stage?: string): string {
  if (stage) return stage;

  switch (status) {
    case "pending":
      return "Queued for processing";
    case "downloading":
      return "Downloading audio";
    case "transcribing":
      return "Transcribing audio";
    case "completed":
      return "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Processing";
  }
}

function getStageIcon(status: JobStatus) {
  switch (status) {
    case "completed":
      return <CheckCircle className="h-5 w-5 text-green-500" />;
    case "failed":
    case "cancelled":
      return <XCircle className="h-5 w-5 text-red-500" />;
    default:
      return <Loader2 className="h-5 w-5 animate-spin text-blue-500" />;
  }
}

export function TranscriptionProgress({
  open,
  onOpenChange,
  jobId,
  onComplete,
  onCancel,
  onError,
}: TranscriptionProgressProps) {
  const [status, setStatus] = useState<JobStatus>("pending");
  const [progress, setProgress] = useState(0);
  const [currentStage, setCurrentStage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [totalChunks, setTotalChunks] = useState<number>();
  const [completedChunks, setCompletedChunks] = useState<number>();
  const [isCancelling, setIsCancelling] = useState(false);

  const pollStatus = useCallback(async () => {
    if (!jobId || !open) return;

    try {
      const response = await fetch(`/api/transcribe/status?jobId=${jobId}`);
      const data: JobStatusResponse = await response.json();

      if (!data.success) {
        setStatus("failed");
        setErrorMessage(data.errorMessage || "Failed to get status");
        return;
      }

      setStatus(data.status);
      setProgress(data.progress);
      setCurrentStage(data.currentStage);
      setTotalChunks(data.totalChunks);
      setCompletedChunks(data.completedChunks);

      if (data.status === "completed" && data.transcriptData) {
        onComplete(data.transcriptData);
        onOpenChange(false);
      } else if (data.status === "failed") {
        setErrorMessage(data.errorMessage || "Transcription failed");
        onError?.(data.errorMessage || "Transcription failed");
      } else if (data.status === "cancelled") {
        setErrorMessage("Transcription was cancelled");
      }
    } catch (error) {
      console.error("Error polling transcription status:", error);
    }
  }, [jobId, open, onComplete, onOpenChange, onError]);

  // Set up polling
  useEffect(() => {
    if (!open || !jobId) return;

    // Initial poll
    pollStatus();

    // Set up interval for subsequent polls
    const interval = setInterval(() => {
      if (status !== "completed" && status !== "failed" && status !== "cancelled") {
        pollStatus();
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [open, jobId, pollStatus, status]);

  const handleCancel = async () => {
    if (isCancelling) return;

    setIsCancelling(true);
    try {
      const response = await fetch(`/api/transcribe/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });

      if (response.ok) {
        setStatus("cancelled");
        onCancel?.();
        onOpenChange(false);
      }
    } catch (error) {
      console.error("Error cancelling transcription:", error);
    } finally {
      setIsCancelling(false);
    }
  };

  const isInProgress = ["pending", "downloading", "transcribing"].includes(status);
  const isComplete = status === "completed";
  const isFailed = status === "failed" || status === "cancelled";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={!isInProgress}>
        <DialogHeader className="space-y-1.5">
          <Badge
            className={`w-fit gap-1 ${
              isComplete
                ? "bg-green-500/15 text-green-700"
                : isFailed
                ? "bg-red-500/15 text-red-700"
                : "bg-blue-500/15 text-blue-700"
            }`}
          >
            {getStageIcon(status)}
            <span className="ml-1">
              {isComplete ? "Complete" : isFailed ? "Error" : "Processing"}
            </span>
          </Badge>
          <DialogTitle className="text-xl font-semibold">
            {isComplete
              ? "Transcription Complete"
              : isFailed
              ? "Transcription Failed"
              : "Generating AI Transcript"}
          </DialogTitle>
          {!isFailed && (
            <DialogDescription className="text-sm text-muted-foreground">
              {isComplete
                ? "Your transcript is ready to use."
                : "You can browse other tabs while this completes."}
            </DialogDescription>
          )}
        </DialogHeader>

        {/* Progress section */}
        {isInProgress && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {getStageLabel(status, currentStage)}
                </span>
                <span className="font-medium">{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>

            {totalChunks && totalChunks > 1 && (
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>Processing audio segments</span>
                <span>
                  {completedChunks || 0} of {totalChunks}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Error message */}
        {isFailed && errorMessage && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {errorMessage}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          {isInProgress && (
            <Button
              variant="ghost"
              onClick={handleCancel}
              disabled={isCancelling}
            >
              {isCancelling ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cancelling...
                </>
              ) : (
                "Cancel"
              )}
            </Button>
          )}

          {(isComplete || isFailed) && (
            <Button onClick={() => onOpenChange(false)}>
              {isComplete ? "Done" : "Close"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inline progress indicator for use in headers/tabs
 */
interface TranscriptionProgressInlineProps {
  status: JobStatus;
  progress: number;
  currentStage?: string;
  onClick?: () => void;
}

export function TranscriptionProgressInline({
  status,
  progress,
  currentStage,
  onClick,
}: TranscriptionProgressInlineProps) {
  const isInProgress = ["pending", "downloading", "transcribing"].includes(status);

  if (!isInProgress) return null;

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-100 transition-colors"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>AI Transcribing {progress}%</span>
    </button>
  );
}
