import { z } from 'zod';
import { STRICT_TIMESTAMP_RANGE_REGEX } from '@/lib/timestamp-utils';

// Shared regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// YouTube Video ID validation
const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
export const youtubeIdSchema = z.string()
  .regex(YOUTUBE_ID_REGEX, 'Invalid YouTube video ID format')
  .max(11);

// URL validation with YouTube specific checks
export const youtubeUrlSchema = z.string()
  .url('Invalid URL format')
  .refine((url) => {
    try {
      const parsed = new URL(url);
      return (
        parsed.hostname === 'youtube.com' ||
        parsed.hostname === 'www.youtube.com' ||
        parsed.hostname === 'youtu.be' ||
        parsed.hostname === 'm.youtube.com'
      );
    } catch {
      return false;
    }
  }, 'URL must be a valid YouTube URL');

// Sanitized text fields
export const sanitizedTextSchema = z.string()
  .min(1, 'Field cannot be empty')
  .max(500, 'Field exceeds maximum length')
  .transform((val) => val.trim())
  .refine((val) => !/<[^>]*>/g.test(val), 'HTML tags are not allowed');

// Video info validation
export const videoInfoSchema = z.object({
  title: z.string().min(1).max(200).transform(val => val.trim()),
  author: z.string().max(100).transform(val => val.trim()).optional(),
  description: z.string().max(5000).optional(),
  duration: z.number().int().min(0).max(86400), // Max 24 hours
  thumbnail: z.string().url().optional(),
  // Use nullish() to accept both null and undefined (backward compat for old cached videos)
  language: z.string().min(2).max(10).nullish().transform(v => v ?? undefined),
  availableLanguages: z.array(z.string().min(2).max(10)).nullish().transform(v => v ?? undefined)
});

// Transcript segment validation
export const transcriptSegmentSchema = z.object({
  text: z.string().max(500000),
  start: z.number().min(0),
  duration: z.number().min(0)
});

export const transcriptSchema = z.array(transcriptSegmentSchema)
  .min(1, 'Transcript must have at least one segment')
  .max(50000, 'Transcript exceeds maximum segments');

// Topic validation
export const topicSchema = z.object({
  id: z.string().max(50),
  title: z.string().min(1).max(100),
  translatedTitle: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  translatedDescription: z.string().max(1000).optional(),
  duration: z.number().int().min(0),
  segments: z.array(z.object({
    start: z.number().min(0),
    end: z.number().min(0),
    text: z.string().max(10000),
    translatedText: z.string().max(20000).optional(),
    startSegmentIdx: z.number().int().min(0).optional(),
    endSegmentIdx: z.number().int().min(0).optional(),
    startCharOffset: z.number().int().min(0).optional(),
    endCharOffset: z.number().int().min(0).optional(),
    hasCompleteSentences: z.boolean().optional(),
    confidence: z.number().min(0).max(1).optional()
  })).max(100),
  keywords: z.array(z.string()).optional(),
  translatedKeywords: z.array(z.string()).optional(),
  quote: z.object({
    timestamp: z.string().regex(STRICT_TIMESTAMP_RANGE_REGEX),
    text: z.string().max(5000),
    translatedText: z.string().max(10000).optional()
  }).optional(),
  isCitationReel: z.boolean().optional(),
  autoPlay: z.boolean().optional()
});

const DEFAULT_AI_VALIDATION_MODEL =
  process.env.AI_DEFAULT_MODEL ?? 'grok-4-1-fast-non-reasoning';

// Model selection validation
export const modelSchema = z
  .string()
  .min(1)
  .max(100)
  .default(DEFAULT_AI_VALIDATION_MODEL);

export const topicGenerationModeSchema = z.enum(['smart', 'fast']);

// Chat message validation
export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string().max(10000),
  citations: z.array(z.object({
    number: z.number(),
    text: z.string().max(5000),
    start: z.number().min(0),
    end: z.number().min(0),
    startSegmentIdx: z.number(),
    endSegmentIdx: z.number(),
    startCharOffset: z.number(),
    endCharOffset: z.number()
  })).optional(),
  timestamp: z.date()
});

// API Request schemas
export const videoAnalysisRequestSchema = z.object({
  videoId: youtubeIdSchema,
  videoInfo: videoInfoSchema,
  transcript: transcriptSchema,
  model: modelSchema,
  mode: topicGenerationModeSchema.optional(),
  forceRegenerate: z.boolean().default(false),
  theme: z.string().min(1).max(80).optional(),
  includeCandidatePool: z.boolean().optional(),
  excludeTopicKeys: z.array(z.string().min(1).max(500)).optional(),
  summary: z.string().nullable().optional(),
  suggestedQuestions: z.array(z.string()).nullable().optional()
});

export const generateTopicsRequestSchema = z.object({
  transcript: transcriptSchema,
  model: modelSchema.optional(),
  mode: topicGenerationModeSchema.optional(),
  includeCandidatePool: z.boolean().optional(),
  excludeTopicKeys: z.array(z.string().min(1).max(500)).optional(),
  videoInfo: videoInfoSchema.optional(),
  language: z.string().min(2).max(10).optional()
});

export const chatRequestSchema = z.object({
  message: z.string().min(1).max(5000),
  transcript: transcriptSchema,
  topics: z.array(topicSchema).optional(),
  chatHistory: z.array(z.object({
    id: z.string().optional(),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    citations: z.array(z.object({
      number: z.number(),
      text: z.string(),
      start: z.number(),
      end: z.number(),
      startSegmentIdx: z.number(),
      endSegmentIdx: z.number(),
      startCharOffset: z.number(),
      endCharOffset: z.number()
    })).optional(),
    timestamp: z.string().or(z.date()).optional()
  })).max(50).optional(),
  targetLanguage: z.string().min(2).max(10).optional()
});

export const toggleFavoriteRequestSchema = z.object({
  videoId: youtubeIdSchema,
  isFavorite: z.boolean()
});

export const noteSourceSchema = z.enum(['chat', 'takeaways', 'transcript', 'custom']);

export const noteMetadataSchema = z.object({
  transcript: z.object({
    start: z.number().min(0),
    end: z.number().min(0).optional(),
    segmentIndex: z.number().int().min(0).optional(),
    topicId: z.string().optional()
  }).optional(),
  chat: z.object({
    messageId: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    timestamp: z.string().optional()
  }).optional(),
  selectedText: z.string().min(1).max(10000).optional(),
  selectionContext: z.string().optional(),
  timestampLabel: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional()
}).passthrough().optional();

export const noteInsertSchema = z.object({
  youtubeId: youtubeIdSchema,
  videoId: z.string().regex(UUID_REGEX, 'Invalid video record ID').optional(),
  source: noteSourceSchema,
  sourceId: z.string().optional(),
  text: z.string().min(1).max(5000),
  metadata: noteMetadataSchema
});

export const noteDeleteSchema = z.object({
  noteId: z.string().regex(UUID_REGEX, 'Invalid note ID')
});

export const checkVideoCacheRequestSchema = z.object({
  videoId: youtubeIdSchema
});

export const updateVideoAnalysisRequestSchema = z.object({
  videoId: youtubeIdSchema,
  summary: z.string().nullable().optional(),
  suggestedQuestions: z.array(z.string()).nullable().optional()
});

// Rate limiting validation
export const rateLimitKeySchema = z.string()
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid rate limit key format');

// Sanitization helpers
export function sanitizeHtml(html: string): string {
  // Remove all HTML tags and attributes
  return html.replace(/<[^>]*>/g, '');
}

export function sanitizeForDatabase(input: string): string {
  // Escape special characters that could be used in SQL injection
  return input
    .replace(/'/g, "''")
    .replace(/;/g, '')
    .replace(/--/g, '')
    .replace(/\/\*/g, '')
    .replace(/\*\//g, '')
    .trim();
}

// Validation error formatter
export function formatValidationError(error: z.ZodError<any>): string {
  const issues = error.issues || [];
  const errors = issues.map((err: any) => {
    const field = err.path?.join('.') || 'field';
    return `${field}: ${err.message}`;
  });
  return errors.join(', ');
}
