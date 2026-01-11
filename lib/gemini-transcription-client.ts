/**
 * Google Gemini API client for AI audio transcription
 *
 * Handles:
 * - Audio transcription via Gemini multimodal API
 * - Structured output with timestamps using JSON schema
 * - Large file support via Files API (>20MB)
 * - Inline base64 for smaller files
 * - Retry logic with model cascade
 */

import {
  GoogleGenerativeAI,
  SchemaType,
} from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { z } from 'zod';
import type { TranscriptSegment } from './types';

// Model cascade - primary model first, then fallbacks
const TRANSCRIPTION_MODELS = [
  'gemini-3-flash-preview',    // Primary: Gemini 3.0 Flash Preview
  'gemini-2.5-flash-lite',     // Fallback: Fast, cost-effective
  'gemini-3-pro-preview',      // Final fallback: Most capable
] as const;

type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];

// Constants
const MAX_INLINE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB - use Files API above this
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const TOKENS_PER_SECOND = 32; // Gemini audio token cost

// Supported audio formats
const SUPPORTED_FORMATS = ['mp3', 'wav', 'aiff', 'aac', 'ogg', 'flac', 'm4a', 'webm', 'mpeg', 'mpga', 'oga'];

const MIME_TYPE_MAP: Record<string, string> = {
  mp3: 'audio/mp3',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  oga: 'audio/ogg',
};

// Zod schemas for structured output
const transcriptionSegmentSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
});

const transcriptionResponseSchema = z.object({
  segments: z.array(transcriptionSegmentSchema),
  language: z.string(),
  totalDuration: z.number(),
});

export interface GeminiTranscriptionOptions {
  /**
   * Language hint (e.g., 'en', 'es', 'zh')
   * If not provided, Gemini will auto-detect
   */
  language?: string;

  /**
   * Override default model
   */
  model?: TranscriptionModel;
}

export interface TranscriptionResult {
  segments: TranscriptSegment[];
  language: string;
  duration: number;
  rawText: string;
}

export interface TranscriptionProgress {
  stage: 'preparing' | 'uploading' | 'transcribing' | 'processing';
  progress: number; // 0-100
  message?: string;
}

type ProgressCallback = (progress: TranscriptionProgress) => void;

/**
 * Get the Gemini API key from environment
 */
function getApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }
  return apiKey;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable
 */
function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number; code?: number }).status ??
                 (error as { status?: number; code?: number }).code;

  return (
    status === 503 ||
    status === 429 ||
    status === 500 ||
    message.includes('503') ||
    message.includes('429') ||
    message.toLowerCase().includes('overload') ||
    message.toLowerCase().includes('rate limit') ||
    message.toLowerCase().includes('quota')
  );
}

/**
 * Check if a file format is supported
 */
export function isSupportedFormat(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return SUPPORTED_FORMATS.includes(ext);
}

/**
 * Estimate transcription cost in cents using Gemini pricing
 *
 * Gemini pricing: $1.00 per 1M audio tokens
 * Audio tokens: 32 tokens per second = 1,920 tokens per minute
 * Cost per minute: 1,920 / 1,000,000 * $1.00 = $0.00192/min = 0.192 cents/min
 *
 * Compared to Whisper: $0.006/min = 0.6 cents/min
 * Gemini is approximately 3x cheaper
 */
export function estimateCostCents(durationSeconds: number): number {
  const tokens = Math.ceil(durationSeconds * TOKENS_PER_SECOND);
  const costDollars = (tokens / 1_000_000) * 1.0;
  const costCents = costDollars * 100;
  // Round to nearest 0.1 cent, minimum 0.1 cent
  return Math.max(0.1, Math.round(costCents * 10) / 10);
}

/**
 * Estimate audio tokens for a given duration
 */
export function estimateAudioTokens(durationSeconds: number): number {
  return Math.ceil(durationSeconds * TOKENS_PER_SECOND);
}

/**
 * Estimate processing time in seconds
 * Gemini processes at ~5x real-time speed
 */
export function estimateProcessingTime(durationSeconds: number): number {
  // 5x real-time processing plus 15s overhead for setup/finalization
  const baseTime = Math.ceil(durationSeconds / 5);
  const overhead = 15;
  return baseTime + overhead;
}

/**
 * Validate audio file before transcription
 */
export function validateAudioFile(file: File | Blob): { valid: boolean; error?: string } {
  if (!file) {
    return { valid: false, error: 'No file provided' };
  }

  if (file.size === 0) {
    return { valid: false, error: 'File is empty' };
  }

  // Gemini supports up to 9.5 hours of audio, but we'll cap at a reasonable limit
  // 9.5 hours at 128kbps = ~520MB
  const MAX_FILE_SIZE = 520 * 1024 * 1024;
  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 520MB.`
    };
  }

  if (file instanceof File) {
    if (!isSupportedFormat(file.name)) {
      return {
        valid: false,
        error: `Unsupported format. Supported: ${SUPPORTED_FORMATS.join(', ')}`
      };
    }
  }

  return { valid: true };
}

/**
 * Get MIME type for a file
 */
function getMimeType(file: File | Blob): string {
  if (file instanceof File && file.type) {
    return file.type;
  }
  if (file instanceof File) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    return MIME_TYPE_MAP[ext || ''] || 'audio/mpeg';
  }
  return 'audio/mpeg';
}

/**
 * Convert Zod schema to Gemini's schema format
 * Using 'any' types to match the existing pattern in gemini-adapter.ts
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertToGeminiSchema(zodSchema: z.ZodTypeAny): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonSchema = z.toJSONSchema(zodSchema) as any;
  return convertJsonToGeminiSchema(jsonSchema);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertJsonToGeminiSchema(jsonSchema: any): any {
  if (!jsonSchema) return { type: SchemaType.STRING };

  // Handle anyOf/oneOf (nullable types)
  if (jsonSchema.anyOf || jsonSchema.oneOf) {
    const schemas = jsonSchema.anyOf || jsonSchema.oneOf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nonNullSchemas = schemas.filter((s: any) => s.type !== 'null');

    if (nonNullSchemas.length === 1) {
      const converted = convertJsonToGeminiSchema(nonNullSchemas[0]);
      if (converted) {
        converted.nullable = true;
      }
      return converted;
    }

    if (nonNullSchemas.length > 0) {
      return convertJsonToGeminiSchema(nonNullSchemas[0]);
    }
  }

  if (jsonSchema.type === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const properties: Record<string, any> = {};
    const required: string[] = jsonSchema.required || [];

    for (const [key, value] of Object.entries(jsonSchema.properties || {})) {
      properties[key] = convertJsonToGeminiSchema(value);
    }

    return {
      type: SchemaType.OBJECT,
      properties,
      required,
    };
  }

  if (jsonSchema.type === 'array') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arraySchema: any = {
      type: SchemaType.ARRAY,
      items: jsonSchema.items
        ? convertJsonToGeminiSchema(jsonSchema.items)
        : { type: SchemaType.STRING },
    };

    if (typeof jsonSchema.minItems === 'number') {
      arraySchema.minItems = jsonSchema.minItems;
    }
    if (typeof jsonSchema.maxItems === 'number') {
      arraySchema.maxItems = jsonSchema.maxItems;
    }

    return arraySchema;
  }

  if (jsonSchema.type === 'string') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stringSchema: any = { type: SchemaType.STRING };
    if (typeof jsonSchema.pattern === 'string') {
      stringSchema.pattern = jsonSchema.pattern;
    }
    return stringSchema;
  }

  if (jsonSchema.type === 'number' || jsonSchema.type === 'integer') {
    return { type: SchemaType.NUMBER };
  }

  if (jsonSchema.type === 'boolean') {
    return { type: SchemaType.BOOLEAN };
  }

  if (Array.isArray(jsonSchema.enum)) {
    return { type: SchemaType.STRING, enum: jsonSchema.enum };
  }

  return { type: SchemaType.STRING };
}

/**
 * Build the transcription prompt
 */
function buildTranscriptionPrompt(languageHint?: string): string {
  const languageInstruction = languageHint
    ? `The audio is in ${languageHint}. `
    : '';

  return `You are an expert transcription service. Transcribe the provided audio file with precise timestamps.

${languageInstruction}For each distinct segment of speech:
1. Provide the exact spoken text
2. Include the start time in seconds (decimal precision to 0.1s)
3. Include the end time in seconds (decimal precision to 0.1s)

Requirements:
- Transcribe ALL spoken content accurately
- Use proper punctuation and capitalization
- Segment at natural sentence or phrase boundaries (roughly 5-15 seconds per segment)
- Detect and report the primary language of the audio
- Calculate the total duration of the audio

Return a JSON object with:
- "segments": array of {text, start, end} objects
- "language": detected language code (e.g., "en", "es", "zh")
- "totalDuration": total audio length in seconds`;
}

/**
 * Prepare inline audio (base64 encoded for files <20MB)
 */
async function prepareInlineAudio(
  audioFile: File | Blob,
  onProgress?: ProgressCallback
): Promise<{ inlineData: { data: string; mimeType: string } }> {
  onProgress?.({
    stage: 'preparing',
    progress: 10,
    message: 'Encoding audio...'
  });

  const arrayBuffer = await audioFile.arrayBuffer();
  const base64Data = Buffer.from(arrayBuffer).toString('base64');
  const mimeType = getMimeType(audioFile);

  return {
    inlineData: {
      data: base64Data,
      mimeType,
    },
  };
}

/**
 * Upload via Files API for large files (>20MB)
 */
async function uploadViaFilesApi(
  audioFile: File | Blob,
  onProgress?: ProgressCallback
): Promise<{ fileData: { fileUri: string; mimeType: string } }> {
  onProgress?.({
    stage: 'uploading',
    progress: 10,
    message: 'Uploading audio file...'
  });

  const apiKey = getApiKey();
  const fileManager = new GoogleAIFileManager(apiKey);

  const filename = audioFile instanceof File ? audioFile.name : 'audio.mp3';
  const mimeType = getMimeType(audioFile);

  // Convert Blob to buffer for upload
  const buffer = Buffer.from(await audioFile.arrayBuffer());

  const uploadResult = await fileManager.uploadFile(buffer, {
    mimeType,
    displayName: filename,
  });

  onProgress?.({
    stage: 'uploading',
    progress: 20,
    message: 'Upload complete, waiting for processing...'
  });

  // Wait for file to be processed
  let file = uploadResult.file;
  while (file.state === 'PROCESSING') {
    await sleep(2000);
    file = await fileManager.getFile(file.name);
  }

  if (file.state !== 'ACTIVE') {
    throw new Error(`File upload failed: ${file.state}`);
  }

  onProgress?.({
    stage: 'uploading',
    progress: 25,
    message: 'File ready for transcription'
  });

  return {
    fileData: {
      fileUri: file.uri,
      mimeType: file.mimeType ?? mimeType,
    },
  };
}

/**
 * Execute transcription with a specific model
 */
async function executeTranscription(
  genAI: GoogleGenerativeAI,
  modelName: string,
  audioPart: { inlineData: { data: string; mimeType: string } } | { fileData: { fileUri: string; mimeType: string } },
  languageHint?: string,
  onProgress?: ProgressCallback
): Promise<TranscriptionResult> {
  const geminiSchema = convertToGeminiSchema(transcriptionResponseSchema);

  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: geminiSchema,
    },
  });

  const prompt = buildTranscriptionPrompt(languageHint);

  onProgress?.({
    stage: 'transcribing',
    progress: 40,
    message: 'Transcribing audio with Gemini AI...'
  });

  const result = await model.generateContent([prompt, audioPart]);

  onProgress?.({
    stage: 'processing',
    progress: 80,
    message: 'Processing transcription results...'
  });

  const responseText = result.response.text();
  const parsed = JSON.parse(responseText);
  const validated = transcriptionResponseSchema.parse(parsed);

  // Convert to TranscriptSegment format (start + duration instead of start + end)
  const segments: TranscriptSegment[] = validated.segments.map(seg => ({
    text: seg.text.trim(),
    start: seg.start,
    duration: seg.end - seg.start,
  }));

  onProgress?.({
    stage: 'processing',
    progress: 100,
    message: 'Transcription complete'
  });

  return {
    segments,
    language: validated.language,
    duration: validated.totalDuration,
    rawText: segments.map(s => s.text).join(' '),
  };
}

/**
 * Transcribe audio using Google Gemini API
 */
export async function transcribeAudio(
  audioFile: File | Blob,
  options: GeminiTranscriptionOptions = {},
  onProgress?: ProgressCallback
): Promise<TranscriptionResult> {
  const apiKey = getApiKey();
  const genAI = new GoogleGenerativeAI(apiKey);

  onProgress?.({
    stage: 'preparing',
    progress: 0,
    message: 'Preparing audio for transcription...'
  });

  // Validate file
  const validation = validateAudioFile(audioFile);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Determine upload strategy based on file size
  const useFilesApi = audioFile.size > MAX_INLINE_SIZE_BYTES;

  let audioPart: { inlineData: { data: string; mimeType: string } } | { fileData: { fileUri: string; mimeType: string } };

  if (useFilesApi) {
    audioPart = await uploadViaFilesApi(audioFile, onProgress);
  } else {
    audioPart = await prepareInlineAudio(audioFile, onProgress);
  }

  onProgress?.({
    stage: 'transcribing',
    progress: 30,
    message: 'Starting transcription...'
  });

  // Build model list (preferred model first, then fallbacks)
  const models = options.model
    ? [options.model, ...TRANSCRIPTION_MODELS.filter(m => m !== options.model)]
    : [...TRANSCRIPTION_MODELS];

  let lastError: Error | null = null;

  for (const modelName of models) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        console.log(`[Gemini Transcription] Trying model ${modelName}, attempt ${attempt + 1}`);

        const result = await executeTranscription(
          genAI,
          modelName,
          audioPart,
          options.language,
          onProgress
        );

        console.log(`[Gemini Transcription] Success with ${modelName}: ${result.segments.length} segments`);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (isRetryableError(error)) {
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[Gemini Transcription] ${modelName} failed (retryable), retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        // Non-retryable error, try next model
        console.warn(`[Gemini Transcription] ${modelName} failed with non-retryable error, trying next model...`);
        break;
      }
    }
  }

  throw lastError || new Error('Gemini transcription failed after all retries');
}

/**
 * Transcribe audio from a URL
 * Fetches the audio and passes it to transcribeAudio
 */
export async function transcribeAudioFromUrl(
  audioUrl: string,
  options: GeminiTranscriptionOptions = {},
  onProgress?: ProgressCallback
): Promise<TranscriptionResult> {
  onProgress?.({
    stage: 'preparing',
    progress: 0,
    message: 'Downloading audio...'
  });

  const response = await fetch(audioUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch audio from URL: ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || 'audio/mpeg';
  const blob = await response.blob();

  const filename = audioUrl.split('/').pop() || 'audio.mp3';
  const file = new File([blob], filename, { type: contentType });

  onProgress?.({
    stage: 'preparing',
    progress: 10,
    message: 'Audio downloaded, preparing for transcription...'
  });

  return transcribeAudio(file, options, (progress) => {
    // Adjust progress to account for download phase (0-10%)
    const adjustedProgress = progress.stage === 'preparing'
      ? 10 + Math.floor(progress.progress * 0.1)
      : progress.progress;

    onProgress?.({
      ...progress,
      progress: adjustedProgress
    });
  });
}

/**
 * Get progress message for current stage
 */
export function getProgressMessage(progress: TranscriptionProgress): string {
  const { stage, message } = progress;

  if (message) return message;

  switch (stage) {
    case 'preparing':
      return 'Preparing audio for transcription...';
    case 'uploading':
      return 'Uploading audio to AI...';
    case 'transcribing':
      return 'Transcribing audio with Gemini AI...';
    case 'processing':
      return 'Processing transcription results...';
    default:
      return `Processing... ${progress.progress}%`;
  }
}

export const GeminiTranscriptionClient = {
  transcribeAudio,
  transcribeAudioFromUrl,
  validateAudioFile,
  isSupportedFormat,
  estimateCostCents,
  estimateAudioTokens,
  estimateProcessingTime,
  getProgressMessage,
};

export default GeminiTranscriptionClient;
