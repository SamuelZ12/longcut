"use client";

import { useState, useRef, useEffect, useCallback, RefObject, Fragment, useMemo } from "react";
import { z } from "zod";
import { ChatMessage, TranscriptSegment, Topic, Citation, NoteSource, NoteMetadata, VideoInfo, TranslationRequestHandler } from "@/lib/types";
import { SelectionActions, SelectionActionPayload, triggerExplainSelection, EXPLAIN_SELECTION_EVENT } from "@/components/selection-actions";
import { ChatMessageComponent } from "./chat-message";
import { SuggestedQuestions } from "./suggested-questions";
import { ImageCheatsheetCard } from "@/components/image-cheatsheet-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Send, Loader2 } from "lucide-react";
import { buildSuggestedQuestionFallbacks, ALL_FALLBACK_QUESTIONS } from "@/lib/suggested-question-fallback";
import { STRICT_TIMESTAMP_RANGE_REGEX, parseTimestamp } from "@/lib/timestamp-utils";
import { sanitizeTimestamp } from "@/lib/timestamp-normalization";

const KEY_TAKEAWAYS_LABEL = "What are the key takeaways?";
const TOP_QUOTES_LABEL = "What are the juciest quotes?";
const PRESET_KEY_TAKEAWAYS = "__preset_key_takeaways__";
const PRESET_TOP_QUOTES = "__preset_top_quotes__";

function normalizeBracketTimestamps(text: string): string {
  return text.replace(/\((\d{1,2}:\d{2}(?::\d{2})?(?:\s*,\s*\d{1,2}:\d{2}(?::\d{2})?)*)\)/g, (_, group) => {
    const parts = group.split(/\s*,\s*/);
    return parts.map((part: string) => `[${part}]`).join(', ');
  });
}

type SuggestedMessage = string | {
  prompt: string;
  display?: string;
  askedLabel?: string;
  skipTracking?: boolean;
};

function normalizeTopicTimestampRange(value?: string): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const inner = trimmed
    .replace(/^[[({\s]+/, '')
    .replace(/[\])}\s]+$/, '')
    .replace(/–|—/g, '-')
    .replace(/\bto\b/gi, '-');

  const parts = inner.split('-').map(part => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }

  const normalizedParts: string[] = [];
  for (const part of parts) {
    const sanitized = sanitizeTimestamp(part);
    if (!sanitized) {
      return null;
    }
    normalizedParts.push(sanitized);
  }

  const [start, end] = normalizedParts;
  const startSeconds = parseTimestamp(start);
  const endSeconds = parseTimestamp(end);

  if (startSeconds == null || endSeconds == null || endSeconds <= startSeconds) {
    return null;
  }

  return `[${start}-${end}]`;
}

const citationSchema = z.object({
  number: z.number(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  startSegmentIdx: z.number(),
  endSegmentIdx: z.number(),
  startCharOffset: z.number(),
  endCharOffset: z.number(),
});

const chatApiResponseSchema = z.object({
  content: z.string().min(1, "Empty response received"),
  citations: z.array(citationSchema).optional(),
});

const summaryResponseSchema = z.union([
  z.object({ summaryContent: z.string().min(1) }),
  z.object({ summary: z.string().min(1) }),
]);

interface AIChatProps {
  transcript: TranscriptSegment[];
  topics: Topic[];
  videoId: string;
  videoTitle?: string;
  videoInfo?: VideoInfo | null;
  onCitationClick: (citation: Citation) => void;
  onTimestampClick: (seconds: number, endSeconds?: number, isCitation?: boolean, citationText?: string) => void;
  cachedSuggestedQuestions?: string[] | null;
  onSaveNote?: (payload: { text: string; source: NoteSource; sourceId?: string | null; metadata?: NoteMetadata | null }) => Promise<void>;
  onTakeNoteFromSelection?: (payload: SelectionActionPayload) => void;
  selectedLanguage?: string | null;
  translationCache?: Map<string, string>;
  onRequestTranslation?: TranslationRequestHandler;
  isAuthenticated?: boolean;
  onRequestSignIn?: () => void;
}

export function AIChat({
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
  onRequestTranslation,
  isAuthenticated,
  onRequestSignIn
}: AIChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [followUpQuestions, setFollowUpQuestions] = useState<string[]>([]);
  const [loadingFollowUps, setLoadingFollowUps] = useState(false);
  const [followUpAnchorId, setFollowUpAnchorId] = useState<string | null>(null);
  const [askedQuestions, setAskedQuestions] = useState<Set<string>>(new Set());

  // Translation state for preset and follow-up questions
  const [translatedKeyTakeawaysLabel, setTranslatedKeyTakeawaysLabel] = useState(KEY_TAKEAWAYS_LABEL);
  const [translatedTopQuotesLabel, setTranslatedTopQuotesLabel] = useState(TOP_QUOTES_LABEL);
  const [translatedFollowUpQuestions, setTranslatedFollowUpQuestions] = useState<string[]>([]);
  // Pre-translated fallback questions map (original -> translated)
  const [, setTranslatedFallbacksMap] = useState<Map<string, string>>(new Map());
  const chatMessagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const presetPromptMapRef = useRef<Map<string, string>>(new Map());
  const dismissedQuestionsRef = useRef<Set<string>>(new Set());
  const followUpQuestionsRef = useRef<string[]>([]);
  const followUpRequestIdRef = useRef(0);
  const isComposingRef = useRef(false);
  const compositionTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }
    
    // Scroll to bottom of viewport only
    const scrollToBottom = () => {
      viewport.scrollTop = viewport.scrollHeight;
    };

    if (messages.length <= 1) {
      scrollToBottom();
    } else {
      // Smooth scroll for subsequent messages
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [messages, isLoading]);

  // Reset questions when video changes
  useEffect(() => {
    setSuggestedQuestions([]);
    setFollowUpQuestions([]);
    setAskedQuestions(new Set());
    presetPromptMapRef.current.clear();
    dismissedQuestionsRef.current = new Set();
    setFollowUpAnchorId(null);
  }, [videoId]);

  useEffect(() => {
    followUpQuestionsRef.current = followUpQuestions;
  }, [followUpQuestions]);

  const applyFallbackSuggestedQuestions = useCallback(() => {
    setSuggestedQuestions(prev => {
      if (prev.length > 0) {
        return prev;
      }
      return buildSuggestedQuestionFallbacks(
        3,
        dismissedQuestionsRef.current
      );
    });
  }, []);

  const sanitizedTopicsForChat = useMemo(() => {
    return topics.map(topic => {
      const timestamp = topic.quote?.timestamp;
      if (!timestamp) {
        return topic;
      }

      const normalized = normalizeTopicTimestampRange(timestamp);

      if (!normalized) {
        const { quote: _, ...rest } = topic;
        void _; // Intentionally unused - extracting quote to exclude it
        return { ...rest };
      }

      if (normalized !== timestamp || !STRICT_TIMESTAMP_RANGE_REGEX.test(timestamp.trim())) {
          const baseQuote = topic.quote ? { ...topic.quote } : { text: "", timestamp: normalized };
          return {
            ...topic,
            quote: {
              ...baseQuote,
              timestamp: normalized
            }
          };
      }

      return topic;
    });
  }, [topics]);

  // Translate suggested questions when language changes
  const [translatedSuggestedQuestions, setTranslatedSuggestedQuestions] = useState<string[]>([]);

  useEffect(() => {
    if (!selectedLanguage || !onRequestTranslation || suggestedQuestions.length === 0) {
      setTranslatedSuggestedQuestions(suggestedQuestions);
      return;
    }

    let isCancelled = false;

    // Translate all suggested questions
    const translateQuestions = async () => {
      const translated = await Promise.all(
        suggestedQuestions.map(async (question, index) => {
          const cacheKey = `chat-suggested-question-${videoId}-${selectedLanguage}-${index}-${question}`;
          try {
            return await onRequestTranslation(question, cacheKey);
          } catch (error) {
            console.error('Failed to translate suggested question:', error);
            return question; // Fallback to original on error
          }
        })
      );
      if (!isCancelled) {
        setTranslatedSuggestedQuestions(translated);
      }
    };

    void translateQuestions();

    return () => {
      isCancelled = true;
    };
  }, [suggestedQuestions, selectedLanguage, onRequestTranslation, videoId]);

  // Use translated questions for display
  const displayedSuggestedQuestions = selectedLanguage ? translatedSuggestedQuestions : suggestedQuestions;

  // Translate preset question labels when language changes
  useEffect(() => {
    if (!selectedLanguage || !onRequestTranslation) {
      setTranslatedKeyTakeawaysLabel(KEY_TAKEAWAYS_LABEL);
      setTranslatedTopQuotesLabel(TOP_QUOTES_LABEL);
      return;
    }

    let isCancelled = false;

    const translatePresetLabels = async () => {
      try {
        const [keyTakeawaysTranslated, topQuotesTranslated] = await Promise.all([
          onRequestTranslation(KEY_TAKEAWAYS_LABEL, `chat-preset-keytakeaways-${selectedLanguage}`),
          onRequestTranslation(TOP_QUOTES_LABEL, `chat-preset-topquotes-${selectedLanguage}`)
        ]);
        if (!isCancelled) {
          setTranslatedKeyTakeawaysLabel(keyTakeawaysTranslated);
          setTranslatedTopQuotesLabel(topQuotesTranslated);
        }
      } catch (error) {
        console.error('Failed to translate preset labels:', error);
        if (!isCancelled) {
          // Fallback to original
          setTranslatedKeyTakeawaysLabel(KEY_TAKEAWAYS_LABEL);
          setTranslatedTopQuotesLabel(TOP_QUOTES_LABEL);
        }
      }
    };

    void translatePresetLabels();

    return () => {
      isCancelled = true;
    };
  }, [selectedLanguage, onRequestTranslation]);

  // Translate follow-up questions when they change or language changes
  useEffect(() => {
    if (!selectedLanguage || !onRequestTranslation || followUpQuestions.length === 0) {
      setTranslatedFollowUpQuestions(followUpQuestions);
      return;
    }

    let isCancelled = false;

    const translateFollowUps = async () => {
      const translated = await Promise.all(
        followUpQuestions.map(async (question, index) => {
          const cacheKey = `chat-followup-${videoId}-${selectedLanguage}-${index}-${question}`;
          try {
            return await onRequestTranslation(question, cacheKey);
          } catch (error) {
            console.error('Failed to translate follow-up question:', error);
            return question;
          }
        })
      );
      if (!isCancelled) {
        setTranslatedFollowUpQuestions(translated);
      }
    };

    void translateFollowUps();

    return () => {
      isCancelled = true;
    };
  }, [followUpQuestions, selectedLanguage, onRequestTranslation, videoId]);

  // Use translated follow-up questions for display
  const displayedFollowUpQuestions = selectedLanguage ? translatedFollowUpQuestions : followUpQuestions;

  // Pre-translate all fallback questions when language changes
  useEffect(() => {
    if (!selectedLanguage || !onRequestTranslation) {
      setTranslatedFallbacksMap(new Map());
      return;
    }

    let isCancelled = false;

    const translateAllFallbacks = async () => {
      const newMap = new Map<string, string>();
      
      await Promise.all(
        ALL_FALLBACK_QUESTIONS.map(async (question) => {
          const cacheKey = `fallback-question-${selectedLanguage}-${question}`;
          try {
            const translated = await onRequestTranslation(question, cacheKey);
            if (!isCancelled) {
              newMap.set(question, translated);
            }
          } catch (error) {
            console.error('Failed to translate fallback question:', error);
            // Keep original on error
            if (!isCancelled) {
              newMap.set(question, question);
            }
          }
        })
      );

      if (!isCancelled) {
        setTranslatedFallbacksMap(newMap);
      }
    };

    void translateAllFallbacks();

    return () => {
      isCancelled = true;
    };
  }, [selectedLanguage, onRequestTranslation]);

  const fetchSuggestedQuestions = useCallback(async () => {
    setLoadingQuestions(true);
    try {
      const response = await fetch("/api/suggested-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          topics: sanitizedTopicsForChat,
          videoTitle,
          count: 3,
          exclude: Array.from(dismissedQuestionsRef.current),
          ...(selectedLanguage && { targetLanguage: selectedLanguage }),
        }),
      });
      
      if (response.ok) {
        let data: unknown;
        try {
          data = await response.json();
        } catch (error) {
          console.error("Failed to parse suggested questions response:", error);
          applyFallbackSuggestedQuestions();
          return;
        }

        const questions = Array.isArray((data as any)?.questions)
          ? (data as any).questions
              .filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
              .map((item: string) => item.trim())
          : [];

        if (questions.length > 0) {
          setSuggestedQuestions(questions);
        } else {
          applyFallbackSuggestedQuestions();
        }
      } else {
        console.error("Suggested questions request failed:", response.status, response.statusText);
        applyFallbackSuggestedQuestions();
      }
    } catch (error) {
      console.error("Error fetching suggested questions:", error);
      applyFallbackSuggestedQuestions();
    } finally {
      setLoadingQuestions(false);
    }
  }, [transcript, sanitizedTopicsForChat, videoTitle, applyFallbackSuggestedQuestions, selectedLanguage]);
  // Update suggested questions when cached questions change
  useEffect(() => {
    if (cachedSuggestedQuestions && cachedSuggestedQuestions.length > 0) {
      setSuggestedQuestions(cachedSuggestedQuestions);
    }
  }, [cachedSuggestedQuestions]);

  // Only fetch new questions if we don't have cached ones
  useEffect(() => {
    if (transcript.length > 0 && suggestedQuestions.length === 0 && !cachedSuggestedQuestions) {
      void fetchSuggestedQuestions();
    }
  }, [transcript, cachedSuggestedQuestions, suggestedQuestions.length, fetchSuggestedQuestions]);

  const requestFollowUpQuestions = useCallback(async (lastQuestion?: string) => {
    const excludeAccumulator = new Set<string>();
    const addToExclude = (question: string | undefined | null) => {
      if (!question) {
        return;
      }
      const trimmed = question.trim();
      if (trimmed.length > 0) {
        excludeAccumulator.add(trimmed);
      }
    };

    dismissedQuestionsRef.current.forEach(addToExclude);
    suggestedQuestions.forEach(addToExclude);
    followUpQuestionsRef.current.forEach(addToExclude);
    addToExclude(lastQuestion);

    const excludeList = Array.from(excludeAccumulator);
    const buildFallbackFollowUps = (existing: string[] = []) =>
      buildSuggestedQuestionFallbacks(2, excludeList, existing);

    if (transcript.length === 0) {
      return buildFallbackFollowUps();
    }

    try {
      const response = await fetch("/api/suggested-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          topics: sanitizedTopicsForChat,
          videoTitle,
          count: 2,
          lastQuestion,
          exclude: excludeList,
          ...(selectedLanguage && { targetLanguage: selectedLanguage }),
        }),
      });

      if (!response.ok) {
        return buildFallbackFollowUps();
      }

      const data = await response.json();
      const nextQuestions = Array.isArray(data.questions)
        ? data.questions
            .filter((q: unknown): q is string => typeof q === "string" && q.trim().length > 0)
            .map((q: string) => q.trim())
        : [];

      if (nextQuestions.length >= 2) {
        return nextQuestions.slice(0, 2);
      }

      const merged = [...nextQuestions];
      const fallback = buildFallbackFollowUps(merged);
      for (const candidate of fallback) {
        if (merged.length >= 2) {
          break;
        }
        if (!merged.some(existing => existing.toLowerCase() === candidate.toLowerCase())) {
          merged.push(candidate);
        }
      }
      return merged.slice(0, 2);
    } catch {
      return buildFallbackFollowUps();
    }
  }, [transcript, sanitizedTopicsForChat, videoTitle, suggestedQuestions, selectedLanguage]);

  const sendMessage = useCallback(async (messageInput?: SuggestedMessage, retryCount = 0) => {
    const isObjectInput = typeof messageInput === "object" && messageInput !== null;
    const promptText = isObjectInput
      ? messageInput.prompt
      : typeof messageInput === "string"
        ? messageInput
        : input.trim();

    const displayText = isObjectInput
      ? messageInput.display ?? messageInput.prompt
      : typeof messageInput === "string"
        ? messageInput
        : input.trim();

    const askedLabel = isObjectInput
      ? messageInput.askedLabel ?? messageInput.display ?? messageInput.prompt
      : typeof messageInput === "string"
        ? messageInput
        : undefined;
    const skipTracking = isObjectInput ? Boolean(messageInput.skipTracking) : false;

    if (!promptText || isLoading) return;

    let shouldGenerateFollowUps = false;
    let followUpPromise: Promise<{ id: number; questions: string[]; error: boolean }> | null = null;
    let assistantMessageId: string | null = null;

    if (transcript.length > 0) {
      const requestId = followUpRequestIdRef.current + 1;
      followUpRequestIdRef.current = requestId;
      setLoadingFollowUps(true);
      followUpPromise = (async () => {
        try {
          const questions = await requestFollowUpQuestions(promptText);
          return { id: requestId, questions, error: false as const };
        } catch {
          return { id: requestId, questions: [] as string[], error: true as const };
        }
      })();
    }

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: displayText,
      timestamp: new Date(),
    };

    // Only add user message on first attempt
    if (retryCount === 0) {
      setMessages(prev => [...prev, userMessage]);
      setInput("");
      if (askedLabel && !skipTracking) {
        setAskedQuestions(prev => {
          const next = new Set(prev);
          next.add(askedLabel);
          return next;
        });
      }
      if (displayText && promptText) {
        presetPromptMapRef.current.set(displayText, promptText);
      }
    }
    setIsLoading(true);

    try {
      // Add timeout controller
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const requestBody = {
        message: promptText,
        transcript,
        topics: sanitizedTopicsForChat,
        videoId,
        chatHistory: messages,
        ...(selectedLanguage && { targetLanguage: selectedLanguage }),
      };

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const rawText = await response.text();

      if (!response.ok) {
        let errorDetails = `Failed to get response (${response.status})`;

        if (response.status === 429 || response.status === 503) {
          throw new Error("Service temporarily unavailable");
        }

        if (rawText) {
          try {
            const errorPayload = JSON.parse(rawText);
            if (errorPayload && typeof errorPayload === "object") {
              const errorMessage = typeof errorPayload.error === "string" ? errorPayload.error : "";
              const errorExplanation = typeof errorPayload.details === "string" ? errorPayload.details : "";
              const fallbackMessage = typeof errorPayload.message === "string" ? errorPayload.message : "";

              const composed = [errorMessage || fallbackMessage, errorExplanation]
                .filter(Boolean)
                .join(": ")
                .trim();

              if (composed.length > 0) {
                errorDetails = composed;
              }
            }
          } catch {
            // ignore JSON parse errors and keep default message
          }
        }

        throw new Error(errorDetails);
      }

      if (!rawText) {
        throw new Error("Empty response received from chat service.");
      }

      let rawData: unknown;
      try {
        rawData = JSON.parse(rawText);
      } catch (parseError) {
        console.error("Failed to parse chat response JSON:", parseError, rawText);
        throw new Error("Received malformed data from chat service.");
      }

      if (rawData && typeof rawData === "object" && "error" in rawData) {
        const errorPayload = rawData as { error?: string; details?: string; message?: string };
        const composed = [errorPayload.error || errorPayload.message, errorPayload.details]
          .filter(Boolean)
          .join(": ")
          .trim();
        throw new Error(composed || "Chat service returned an error.");
      }

      const parsedData = chatApiResponseSchema.parse(rawData);
      const normalizedContent = normalizeBracketTimestamps(parsedData.content);

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: normalizedContent,
        citations: parsedData.citations || [],
        timestamp: new Date(),
      };
      assistantMessageId = assistantMessage.id;

      setMessages(prev => [...prev, assistantMessage]);
      shouldGenerateFollowUps = true;
    } catch (error) {
      console.error("Chat message error:", error);
      
      // Retry logic for temporary failures
      const errorName = error instanceof Error ? error.name : '';
      const errorMessage = error instanceof Error ? error.message : '';
      if (retryCount < 2 && (
        errorName === 'AbortError' ||
        errorMessage.includes('temporarily unavailable') ||
        errorMessage.includes('Empty response')
      )) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 1500 * (retryCount + 1)));
        return sendMessage(
          isObjectInput ? messageInput : promptText,
          retryCount + 1
        );
      }
      
      // Provide specific error messages
      let errorContent = "Sorry, I encountered an error processing your request.";
      
      if (errorName === 'AbortError') {
        errorContent = "The request took too long to process. Please try again with a simpler question.";
      } else if (errorMessage.includes('temporarily unavailable')) {
        errorContent = "The AI service is temporarily unavailable. Please try again in a moment.";
      } else if (errorMessage.includes('Empty response')) {
        errorContent = "I couldn't generate a proper response. Please try rephrasing your question.";
      } else if (errorMessage && errorMessage !== errorContent) {
        errorContent = errorMessage;
      }
      
      const errorMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: errorContent,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
      if (followUpPromise) {
        const { id, questions, error } = await followUpPromise;
        if (followUpRequestIdRef.current === id) {
          if (!error && shouldGenerateFollowUps) {
            if (assistantMessageId && questions.length > 0) {
              setFollowUpQuestions(questions);
              setFollowUpAnchorId(assistantMessageId);
            } else if (assistantMessageId) {
              setFollowUpQuestions([]);
              setFollowUpAnchorId(null);
            }
          }
          setLoadingFollowUps(false);
        }
      }
    }
  }, [input, isLoading, messages, transcript, sanitizedTopicsForChat, videoId, requestFollowUpQuestions, selectedLanguage]);

  const executeKeyTakeaways = useCallback(
    async ({ skipUserMessage = false }: { skipUserMessage?: boolean } = {}) => {
      if (transcript.length === 0) {
        return;
      }

      if (isLoading) {
        return;
      }

      if (!skipUserMessage && askedQuestions.has(KEY_TAKEAWAYS_LABEL)) {
        return;
      }

      presetPromptMapRef.current.set(KEY_TAKEAWAYS_LABEL, PRESET_KEY_TAKEAWAYS);

      if (!skipUserMessage) {
        const userMessage: ChatMessage = {
          id: Date.now().toString(),
          role: "user",
          content: translatedKeyTakeawaysLabel,
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, userMessage]);
      }

      setAskedQuestions(prev => {
        const next = new Set(prev);
        next.add(KEY_TAKEAWAYS_LABEL);
        return next;
      });

      setIsLoading(true);
      let followUpPromise: Promise<{ id: number; questions: string[]; error: boolean }> | null = null;
      let shouldGenerateFollowUps = false;
      let assistantMessageId: string | null = null;

      if (transcript.length > 0) {
        const requestId = followUpRequestIdRef.current + 1;
        followUpRequestIdRef.current = requestId;
        setLoadingFollowUps(true);
        followUpPromise = (async () => {
          try {
            const questions = await requestFollowUpQuestions(KEY_TAKEAWAYS_LABEL);
            return { id: requestId, questions, error: false as const };
          } catch {
            return { id: requestId, questions: [] as string[], error: true as const };
          }
        })();
      }

      try {
        const requestVideoInfo: Partial<VideoInfo> = {
          title: videoInfo?.title ?? videoTitle ?? "Untitled video",
          author: videoInfo?.author,
          description: videoInfo?.description,
        };

        const summaryResponse = await fetch("/api/generate-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript,
            videoInfo: requestVideoInfo,
            videoId,
            ...(selectedLanguage && { targetLanguage: selectedLanguage }),
          }),
        });

        if (!summaryResponse.ok) {
          const errorData = await summaryResponse.json().catch(() => ({}));
          const errorText = typeof errorData.error === "string" ? errorData.error : "Failed to generate takeaways.";
          throw new Error(errorText);
        }

        const rawSummary = await summaryResponse.json();
        const parsedSummary = summaryResponseSchema.parse(rawSummary);
        const content = 'summaryContent' in parsedSummary
          ? parsedSummary.summaryContent
          : parsedSummary.summary;

        const normalizedContent = normalizeBracketTimestamps(content);

        const assistantMessage: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: normalizedContent,
          timestamp: new Date(),
        };

        setMessages(prev => [...prev, assistantMessage]);
        assistantMessageId = assistantMessage.id;
        shouldGenerateFollowUps = true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Failed to generate takeaways. Please try again.";

        setMessages(prev => [...prev, {
          id: (Date.now() + 2).toString(),
          role: "assistant",
          content: errorMessage,
          timestamp: new Date(),
        }]);

        setAskedQuestions(prev => {
          const next = new Set(prev);
          next.delete(KEY_TAKEAWAYS_LABEL);
          return next;
        });
      } finally {
        setIsLoading(false);
        if (followUpPromise) {
          const { id, questions, error } = await followUpPromise;
          if (followUpRequestIdRef.current === id) {
            if (!error && shouldGenerateFollowUps) {
              if (assistantMessageId && questions.length > 0) {
                setFollowUpQuestions(questions);
                setFollowUpAnchorId(assistantMessageId);
              } else if (assistantMessageId) {
                setFollowUpQuestions([]);
                setFollowUpAnchorId(null);
              }
            }
            setLoadingFollowUps(false);
          }
        }
      }
    },
    [askedQuestions, isLoading, transcript, videoInfo, videoId, videoTitle, requestFollowUpQuestions, selectedLanguage, translatedKeyTakeawaysLabel]
  );

  const executeTopQuotes = useCallback(
    async ({ skipUserMessage = false }: { skipUserMessage?: boolean } = {}) => {
      if (transcript.length === 0) {
        return;
      }

      if (isLoading) {
        return;
      }

      if (!skipUserMessage && askedQuestions.has(TOP_QUOTES_LABEL)) {
        return;
      }

      presetPromptMapRef.current.set(TOP_QUOTES_LABEL, PRESET_TOP_QUOTES);

      if (!skipUserMessage) {
        const userMessage: ChatMessage = {
          id: Date.now().toString(),
          role: "user",
          content: translatedTopQuotesLabel,
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, userMessage]);
      }

      setAskedQuestions(prev => {
        const next = new Set(prev);
        next.add(TOP_QUOTES_LABEL);
        return next;
      });

      setIsLoading(true);
      let followUpPromise: Promise<{ id: number; questions: string[]; error: boolean }> | null = null;
      let shouldGenerateFollowUps = false;
      let assistantMessageId: string | null = null;

      if (transcript.length > 0) {
        const requestId = followUpRequestIdRef.current + 1;
        followUpRequestIdRef.current = requestId;
        setLoadingFollowUps(true);
        followUpPromise = (async () => {
          try {
            const questions = await requestFollowUpQuestions(TOP_QUOTES_LABEL);
            return { id: requestId, questions, error: false as const };
          } catch {
            return { id: requestId, questions: [] as string[], error: true as const };
          }
        })();
      }

      try {
        const requestVideoInfo: Partial<VideoInfo> = {
          title: videoInfo?.title ?? videoTitle ?? "Untitled video",
          author: videoInfo?.author,
          description: videoInfo?.description,
        };

        const response = await fetch("/api/top-quotes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript,
            videoInfo: requestVideoInfo,
            ...(selectedLanguage && { targetLanguage: selectedLanguage }),
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorText = typeof errorData.error === "string" ? errorData.error : "Failed to generate top quotes.";
          throw new Error(errorText);
        }

        const data = await response.json();
        const content = typeof data.quotesMarkdown === "string" && data.quotesMarkdown.trim().length > 0
          ? data.quotesMarkdown
          : null;

        if (!content) {
          throw new Error("No quotes were returned. Please try again.");
        }

        const assistantMessage: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content,
          timestamp: new Date(),
        };

        setMessages(prev => [...prev, assistantMessage]);
        assistantMessageId = assistantMessage.id;
        shouldGenerateFollowUps = true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Failed to generate top quotes. Please try again.";

        setMessages(prev => [...prev, {
          id: (Date.now() + 2).toString(),
          role: "assistant",
          content: errorMessage,
          timestamp: new Date(),
        }]);

        setAskedQuestions(prev => {
          const next = new Set(prev);
          next.delete(TOP_QUOTES_LABEL);
          return next;
        });
      } finally {
        setIsLoading(false);
        if (followUpPromise) {
          const { id, questions, error } = await followUpPromise;
          if (followUpRequestIdRef.current === id) {
            if (!error && shouldGenerateFollowUps) {
              if (assistantMessageId && questions.length > 0) {
                setFollowUpQuestions(questions);
                setFollowUpAnchorId(assistantMessageId);
              } else if (assistantMessageId) {
                setFollowUpQuestions([]);
                setFollowUpAnchorId(null);
              }
            }
            setLoadingFollowUps(false);
          }
        }
      }
    },
    [askedQuestions, isLoading, transcript, videoInfo, videoTitle, requestFollowUpQuestions, selectedLanguage, translatedTopQuotesLabel]
  );

  const handleAskKeyTakeaways = useCallback(() => {
    void executeKeyTakeaways();
  }, [executeKeyTakeaways]);

  const handleAskTopQuotes = useCallback(() => {
    void executeTopQuotes();
  }, [executeTopQuotes]);

  useEffect(() => {
    const handleExplain = (event: Event) => {
      const custom = event as CustomEvent<SelectionActionPayload>;
      const detail = custom.detail;
      if (!detail?.text?.trim()) {
        return;
      }

      const prompt = `Explain "${detail.text.trim()}"`;

      sendMessage(prompt);
    };

    window.addEventListener(EXPLAIN_SELECTION_EVENT, handleExplain as EventListener);
    return () => {
      window.removeEventListener(EXPLAIN_SELECTION_EVENT, handleExplain as EventListener);
    };
  }, [sendMessage, videoTitle]);

  const handleSuggestedQuestionClick = useCallback((displayedQuestion: string, index: number) => {
    if (isLoading) {
      return;
    }

    // Get the original question (in English) at this index
    const originalQuestion = suggestedQuestions[index];

    if (!originalQuestion) {
      console.warn('Question index out of bounds, using displayed question as fallback');
      // Fallback to displayed question if index is invalid
      sendMessage({
        prompt: displayedQuestion,
        display: displayedQuestion,
        skipTracking: true,
      });
      return;
    }

    setSuggestedQuestions(prev => prev.filter((_, i) => i !== index));
    dismissedQuestionsRef.current.add(originalQuestion);

    sendMessage({
      prompt: originalQuestion, // Send original English question to API
      display: displayedQuestion, // Show translated question to user
      skipTracking: true,
    });
  }, [isLoading, sendMessage, suggestedQuestions]);

  const handleFollowUpQuestionClick = useCallback((displayedQuestion: string, index: number) => {
    if (isLoading) {
      return;
    }

    // Get the original question (in English) at this index
    const originalQuestion = followUpQuestions[index];

    if (!originalQuestion) {
      console.warn('Follow-up question index out of bounds, using displayed question as fallback');
      // Fallback to displayed question if index is invalid
      sendMessage({
        prompt: displayedQuestion,
        display: displayedQuestion,
        skipTracking: true,
      });
      return;
    }

    setFollowUpQuestions(prev => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) {
        setFollowUpAnchorId(null);
      }
      return next;
    });
    dismissedQuestionsRef.current.add(originalQuestion);
    sendMessage({
      prompt: originalQuestion, // Send original English question to API
      display: displayedQuestion, // Show translated question to user
      skipTracking: true,
    });
  }, [isLoading, sendMessage, followUpQuestions]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !isComposingRef.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleRetry = useCallback((messageId: string) => {
    const messageIndex = messages.findIndex(m => m.id === messageId);
    if (messageIndex > 0) {
      const userMessage = messages[messageIndex - 1];
      if (userMessage.role === 'user') {
        // Remove the assistant message being retried
        setMessages(prev => prev.filter((_, i) => i !== messageIndex));
        // Pass retryCount > 0 to prevent re-adding the user message
        const presetPrompt = presetPromptMapRef.current.get(userMessage.content);
        if (presetPrompt === PRESET_KEY_TAKEAWAYS) {
          void executeKeyTakeaways({ skipUserMessage: true });
          return;
        }
        if (presetPrompt === PRESET_TOP_QUOTES) {
          void executeTopQuotes({ skipUserMessage: true });
          return;
        }
        if (typeof presetPrompt === "string") {
          sendMessage({
            prompt: presetPrompt,
            display: userMessage.content,
            askedLabel: userMessage.content,
          }, 1);
        } else {
          sendMessage(userMessage.content, 1);
        }
      }
    }
  }, [messages, executeKeyTakeaways, executeTopQuotes, sendMessage]);

  const handleImageGenerated = useCallback((data: {
    imageUrl: string;
    modelUsed: string;
    remaining: number | null;
    limit: number;
    aspectRatio: string;
    style: string;
  }) => {
    const imageMessage: ChatMessage = {
      id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: 'assistant',
      content: '✨ Your cheatsheet is ready!',
      imageUrl: data.imageUrl,
      imageMetadata: {
        modelUsed: data.modelUsed,
        aspectRatio: data.aspectRatio,
        style: data.style,
      },
      timestamp: new Date()
    };

    setMessages(prev => [...prev, imageMessage]);

    // Auto-scroll to the new image message
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  const hasAskedKeyTakeaways = askedQuestions.has(KEY_TAKEAWAYS_LABEL);
  const hasAskedTopQuotes = askedQuestions.has(TOP_QUOTES_LABEL);

  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0} disableHoverableContent={false}>
      <div className="w-full h-full flex flex-col">
        <ScrollArea className="flex-1 px-6" ref={(node) => {
          if (node) {
            // Radix ScrollArea has a viewport element as its first child
            const viewport = node.querySelector('[data-slot="scroll-area-viewport"]') as HTMLDivElement;
            scrollViewportRef.current = viewport;
          }
        }}>
          <div className="space-y-3.5 pt-3">
            <div className="flex w-full flex-col items-end gap-2">
              <ImageCheatsheetCard
                transcript={transcript}
                videoId={videoId}
                videoTitle={videoTitle}
                videoAuthor={videoInfo?.author}
                isAuthenticated={isAuthenticated}
                onRequestSignIn={onRequestSignIn}
                onImageGenerated={handleImageGenerated}
                selectedLanguage={selectedLanguage}
                onRequestTranslation={onRequestTranslation}
              />
              {!hasAskedKeyTakeaways && (
                <Button
                  variant="pill"
                  size="sm"
                  onClick={handleAskKeyTakeaways}
                  disabled={isLoading || transcript.length === 0}
                  className="self-end w-fit max-w-full sm:max-w-[80%] h-auto justify-start text-left whitespace-normal break-words leading-snug py-2 px-4 transition-colors hover:bg-neutral-100"
                >
                  {translatedKeyTakeawaysLabel}
                </Button>
              )}
              {!hasAskedTopQuotes && (
                <Button
                  variant="pill"
                  size="sm"
                  onClick={handleAskTopQuotes}
                  disabled={isLoading || transcript.length === 0}
                  className="self-end w-fit max-w-full sm:max-w-[80%] h-auto justify-start text-left whitespace-normal break-words leading-snug py-2 px-4 transition-colors hover:bg-neutral-100"
                >
                  {translatedTopQuotesLabel}
                </Button>
              )}
              <SuggestedQuestions
                questions={displayedSuggestedQuestions}
                onQuestionClick={handleSuggestedQuestionClick}
                isLoading={loadingQuestions}
                isChatLoading={isLoading}
              />
            </div>
            <div ref={chatMessagesContainerRef}>
              <SelectionActions
                containerRef={chatMessagesContainerRef as unknown as RefObject<HTMLElement | null>}
                onExplain={(payload) => {
                  triggerExplainSelection({
                    ...payload,
                    source: 'chat'
                  });
                }}
                onTakeNote={(payload) => {
                  onTakeNoteFromSelection?.({
                    ...payload,
                    source: 'chat'
                  });
                }}
                source="chat"
              />
              {messages.map((message) => {
                const showFollowUps =
                  followUpQuestions.length > 0 &&
                  followUpAnchorId !== null &&
                  message.id === followUpAnchorId;
                return (
                  <Fragment key={message.id}>
                    <ChatMessageComponent
                      message={message}
                      onCitationClick={onCitationClick}
                      onTimestampClick={onTimestampClick}
                      onRetry={message.role === 'assistant' ? handleRetry : undefined}
                      onSaveNote={message.role === 'assistant' ? onSaveNote : undefined}
                    />
                    {showFollowUps && (
                      <div className="mt-3">
                        <SuggestedQuestions
                          questions={displayedFollowUpQuestions}
                          onQuestionClick={handleFollowUpQuestionClick}
                          isLoading={loadingFollowUps}
                          isChatLoading={isLoading}
                        />
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
            {isLoading && (
              <div className="flex items-center gap-2 mb-3">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                <p className="text-xs text-muted-foreground">Thinking...</p>
              </div>
            )}
            <div ref={messagesEndRef} className="pb-24" />
          </div>
        </ScrollArea>
        <div className="px-6 pt-[18px] pb-6">
          <div className="relative">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                clearTimeout(compositionTimeoutRef.current);
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                // Delay resetting the flag so the keydown handler for the
                // same Enter keystroke still sees isComposing as true.
                // In some browsers (e.g. Chrome with Chinese IME),
                // compositionend fires before keydown for the Enter key
                // that confirms the composition.
                compositionTimeoutRef.current = setTimeout(() => {
                  isComposingRef.current = false;
                }, 0);
              }}
              placeholder="Ask about the video..."
              className="resize-none rounded-[20px] text-xs bg-neutral-100 border-[#ebecee] pr-11"
              rows={2}
              disabled={isLoading}
            />
            <Button
              onClick={() => sendMessage()}
              disabled={!input.trim() || isLoading}
              size="icon"
              className="absolute right-2 bottom-2 rounded-full h-8 w-8"
            >
              {isLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
