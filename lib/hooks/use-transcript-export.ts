import { useState, useCallback, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createTranscriptExport, type TranscriptExportFormat, type TranscriptExportMode } from '@/lib/transcript-export';
// MVP: Subscription checks removed - all logged-in users can export
import type { TranscriptSegment, Topic, VideoInfo, TranslationRequestHandler } from '@/lib/types';
import type { BulkTranslationHandler } from './use-translation';

interface UseTranscriptExportOptions {
  videoId: string | null;
  transcript: TranscriptSegment[];
  topics: Topic[];
  videoInfo: VideoInfo | null;
  user: any;
  hasSpeakerData: boolean;
  // MVP: Subscription props removed
  onAuthRequired: () => void;
  onRequestTranslation: TranslationRequestHandler;
  onBulkTranslation: BulkTranslationHandler;
  translationCache: Map<string, string>;
}

export function useTranscriptExport({
  videoId,
  transcript,
  topics,
  videoInfo,
  user,
  hasSpeakerData,
  // MVP: Subscription destructuring removed
  onAuthRequired,
  onBulkTranslation,
  translationCache,
}: UseTranscriptExportOptions) {
  const router = useRouter();

  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<TranscriptExportFormat>('txt');
  const [exportMode, setExportMode] = useState<TranscriptExportMode>('original');
  const [targetLanguage, setTargetLanguage] = useState<string>('es'); // Default to Spanish
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [includeSpeakers, setIncludeSpeakers] = useState(false);
  const [exportErrorMessage, setExportErrorMessage] = useState<string | null>(null);
  const [exportDisableMessage, setExportDisableMessage] = useState<string | null>(null);
  const [isExportingTranscript, setIsExportingTranscript] = useState(false);
  const [showExportUpsell, setShowExportUpsell] = useState(false);
  const [translationProgress, setTranslationProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);

  useEffect(() => {
    if (exportFormat === 'srt' && !includeTimestamps) {
      setIncludeTimestamps(true);
    }
  }, [exportFormat, includeTimestamps]);

  useEffect(() => {
    if (!hasSpeakerData && includeSpeakers) {
      setIncludeSpeakers(false);
    }
  }, [hasSpeakerData, includeSpeakers]);

  const handleExportDialogOpenChange = useCallback((open: boolean) => {
    setIsExportDialogOpen(open);
    if (!open) {
      setExportErrorMessage(null);
      setExportDisableMessage(null);
      // Reset non-essential state
      setExportMode('original');
    }
  }, []);

  const handleRequestExport = useCallback(async () => {
    if (!videoId || transcript.length === 0) {
      toast.error('Transcript is still loading. Try again in a few seconds.');
      return;
    }

    if (!user) {
      onAuthRequired();
      return;
    }

    // MVP: Allow all logged-in users to export without subscription checks
    setExportDisableMessage(null);
    setExportErrorMessage(null);
    setIsExportDialogOpen(true);
  }, [
    videoId,
    transcript.length,
    user,
    onAuthRequired,
  ]);

  const handleConfirmExport = useCallback(async () => {
    if (transcript.length === 0) {
      setExportErrorMessage('Transcript is still loading. Please try again.');
      return;
    }

    // MVP: Skip subscription checks - allow all logged-in users to export

    setIsExportingTranscript(true);
    setExportErrorMessage(null);

    try {
      let translatedTranscript: string[] = [];

      // Handle translation if required
      if (exportMode !== 'original') {
        const translations: string[] = new Array(transcript.length).fill('');

        // 1. Identify missing translations
        const segmentsToTranslate: { index: number; text: string }[] = [];

        transcript.forEach((segment, index) => {
          const cacheKey = `transcript:${index}:${targetLanguage}`;
          if (translationCache.has(cacheKey)) {
            translations[index] = translationCache.get(cacheKey)!;
          } else {
            segmentsToTranslate.push({ index, text: segment.text });
          }
        });

        // 2. Request missing translations using bulk API for faster processing
        if (segmentsToTranslate.length > 0) {
          const translationMap = await onBulkTranslation(
            segmentsToTranslate,
            targetLanguage,
            'transcript',
            videoInfo,
            (completed, total) => setTranslationProgress({ completed, total })
          );

          // Apply results from bulk translation
          for (const [index, translation] of translationMap) {
            translations[index] = translation;
          }

          setTranslationProgress(null);
        }

        translatedTranscript = translations;
      }

      const { blob, filename } = createTranscriptExport(transcript, {
        format: exportFormat,
        exportMode,
        translatedTranscript,
        includeSpeakers: includeSpeakers && hasSpeakerData,
        includeTimestamps: exportFormat === 'srt' ? true : includeTimestamps,
        videoTitle: videoInfo?.title,
        videoAuthor: videoInfo?.author,
        topics,
      });

      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(downloadUrl);

      toast.success('Transcript export started');
      setIsExportDialogOpen(false);
      setExportDisableMessage(null);
      // MVP: Subscription status refresh removed
    } catch (error) {
      console.error('Transcript export failed:', error);
      const message =
        error instanceof Error ? error.message : 'Failed to export transcript. Please try again.';
      setExportErrorMessage(message);
      toast.error("We couldn't generate that export. Try again in a moment.");
    } finally {
      setIsExportingTranscript(false);
    }
  }, [
    transcript,

    exportFormat,
    exportMode,
    targetLanguage,
    includeSpeakers,
    hasSpeakerData,
    includeTimestamps,
    videoInfo,
    topics,
    onBulkTranslation,
    translationCache
  ]);

  const handleUpgradeClick = useCallback(() => {
    router.push('/pricing');
  }, [router]);

  const exportButtonState = useMemo(() => {
    if (!videoId || transcript.length === 0) {
      return {
        disabled: true,
        tooltip: 'Transcript is still loading',
      };
    }

    if (isExportingTranscript) {
      return {
        disabled: true,
        isLoading: true,
        tooltip: 'Preparing export…',
      };
    }

    // MVP: Only require login, no subscription checks
    if (!user) {
      return {
        tooltip: 'Sign in to export transcripts',
      };
    }

    return {
      tooltip: 'Export transcript',
    };
  }, [
    videoId,
    transcript.length,
    isExportingTranscript,
    user,
  ]);

  return {
    isExportDialogOpen,
    exportFormat,
    exportMode,
    targetLanguage,
    includeTimestamps,
    includeSpeakers,
    exportErrorMessage,
    exportDisableMessage,
    isExportingTranscript,
    showExportUpsell,
    exportButtonState,
    translationProgress,
    setExportFormat,
    setExportMode,
    setTargetLanguage,
    setIncludeTimestamps,
    setIncludeSpeakers,
    setShowExportUpsell,
    handleExportDialogOpenChange,
    handleRequestExport,
    handleConfirmExport,
    handleUpgradeClick,
  };
}
