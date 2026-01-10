/**
 * OpenAI Whisper API client for AI transcription
 *
 * Handles:
 * - Audio transcription via Whisper API
 * - Chunking for long audio files (25MB limit)
 * - Timestamp parsing and segment generation
 * - Retry logic with exponential backoff
 */

import type { TranscriptSegment } from './types';

// Whisper API constants
const WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

// Supported audio formats for Whisper
const SUPPORTED_FORMATS = ['mp3', 'mp4', 'm4a', 'wav', 'webm', 'mpeg', 'mpga', 'oga', 'ogg'];

export interface WhisperTranscriptionOptions {
  /**
   * Language code (e.g., 'en', 'es', 'zh')
   * If not provided, Whisper will auto-detect
   */
  language?: string;

  /**
   * Prompt to guide the model (can include terminology, context)
   */
  prompt?: string;

  /**
   * Response format - we use 'verbose_json' for timestamps
   */
  responseFormat?: 'json' | 'verbose_json' | 'text' | 'srt' | 'vtt';

  /**
   * Temperature for sampling (0-1)
   */
  temperature?: number;

  /**
   * Timestamp granularities - segment or word level
   */
  timestampGranularities?: ('segment' | 'word')[];
}

export interface WhisperSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
}

export interface WhisperResponse {
  task: string;
  language: string;
  duration: number;
  text: string;
  segments: WhisperSegment[];
}

export interface TranscriptionResult {
  segments: TranscriptSegment[];
  language: string;
  duration: number;
  rawText: string;
}

export interface TranscriptionProgress {
  stage: 'preparing' | 'transcribing' | 'processing';
  progress: number; // 0-100
  currentChunk?: number;
  totalChunks?: number;
  message?: string;
}

type ProgressCallback = (progress: TranscriptionProgress) => void;

/**
 * Get the OpenAI API key from environment
 */
function getApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
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
 * Check if a file format is supported by Whisper
 */
export function isSupportedFormat(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return SUPPORTED_FORMATS.includes(ext);
}

/**
 * Estimate transcription cost in cents
 * Whisper: $0.006 per minute = $0.0001 per second
 */
export function estimateCostCents(durationSeconds: number): number {
  const costPerMinute = 0.6; // cents
  const minutes = Math.ceil(durationSeconds / 60);
  return Math.round(minutes * costPerMinute);
}

/**
 * Estimate processing time in seconds
 * Roughly 1:1 ratio with some overhead
 */
export function estimateProcessingTime(durationSeconds: number): number {
  // Base processing time (1:1 ratio) plus 30s overhead
  const baseTime = durationSeconds;
  const overhead = 30;
  return Math.ceil(baseTime + overhead);
}

/**
 * Transcribe audio using OpenAI Whisper API
 */
export async function transcribeAudio(
  audioFile: File | Blob,
  options: WhisperTranscriptionOptions = {},
  onProgress?: ProgressCallback
): Promise<TranscriptionResult> {
  const apiKey = getApiKey();

  // Report initial progress
  onProgress?.({
    stage: 'preparing',
    progress: 0,
    message: 'Preparing audio for transcription...'
  });

  // Check file size
  if (audioFile.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Audio file too large (${(audioFile.size / 1024 / 1024).toFixed(1)}MB). ` +
      `Maximum size is 25MB. Please use chunked transcription for longer audio.`
    );
  }

  // Create form data
  const formData = new FormData();
  formData.append('file', audioFile);
  formData.append('model', 'whisper-1');
  formData.append('response_format', options.responseFormat || 'verbose_json');

  if (options.language) {
    formData.append('language', options.language);
  }

  if (options.prompt) {
    formData.append('prompt', options.prompt);
  }

  if (options.temperature !== undefined) {
    formData.append('temperature', options.temperature.toString());
  }

  if (options.timestampGranularities?.length) {
    // Note: timestamp_granularities requires response_format to be verbose_json
    options.timestampGranularities.forEach(g => {
      formData.append('timestamp_granularities[]', g);
    });
  }

  onProgress?.({
    stage: 'transcribing',
    progress: 10,
    message: 'Sending audio to Whisper API...'
  });

  // Make request with retry logic
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(WHISPER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;

        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorText;
        } catch {
          errorMessage = errorText;
        }

        // Check if retryable
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Whisper API error (${response.status}): ${errorMessage}`);
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.warn(`Whisper API request failed, retrying in ${delay}ms...`, lastError);
          await sleep(delay);
          continue;
        }

        throw new Error(`Whisper API error (${response.status}): ${errorMessage}`);
      }

      onProgress?.({
        stage: 'processing',
        progress: 80,
        message: 'Processing transcription results...'
      });

      const data = await response.json() as WhisperResponse;

      // Convert Whisper segments to our TranscriptSegment format
      const segments = convertWhisperSegments(data.segments);

      onProgress?.({
        stage: 'processing',
        progress: 100,
        message: 'Transcription complete'
      });

      return {
        segments,
        language: data.language,
        duration: data.duration,
        rawText: data.text,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Whisper API error')) {
        throw error; // Don't retry non-retryable errors
      }
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`Whisper API request failed, retrying in ${delay}ms...`, lastError);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error('Whisper transcription failed after multiple retries');
}

/**
 * Convert Whisper API segments to our TranscriptSegment format
 */
function convertWhisperSegments(whisperSegments: WhisperSegment[]): TranscriptSegment[] {
  return whisperSegments.map(seg => ({
    text: seg.text.trim(),
    start: seg.start,
    duration: seg.end - seg.start,
  }));
}

/**
 * Transcribe audio from a URL
 * Fetches the audio and passes it to transcribeAudio
 */
export async function transcribeAudioFromUrl(
  audioUrl: string,
  options: WhisperTranscriptionOptions = {},
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

  // Create a File object with proper name and type
  const filename = audioUrl.split('/').pop() || 'audio.mp3';
  const file = new File([blob], filename, { type: contentType });

  onProgress?.({
    stage: 'preparing',
    progress: 20,
    message: 'Audio downloaded, preparing for transcription...'
  });

  return transcribeAudio(file, options, (progress) => {
    // Adjust progress to account for download phase (0-20%)
    onProgress?.({
      ...progress,
      progress: 20 + Math.floor(progress.progress * 0.8)
    });
  });
}

/**
 * Estimate the number of chunks needed for an audio file
 * Assumes ~1.5MB per minute for MP3 at 192kbps
 */
export function estimateChunks(durationSeconds: number, format: string = 'mp3'): number {
  // Approximate file size based on format
  let bytesPerSecond: number;

  switch (format.toLowerCase()) {
    case 'mp3':
      bytesPerSecond = 24000; // ~192kbps
      break;
    case 'm4a':
    case 'aac':
      bytesPerSecond = 16000; // ~128kbps
      break;
    case 'wav':
      bytesPerSecond = 176400; // 44.1kHz, 16-bit, stereo
      break;
    default:
      bytesPerSecond = 24000; // Default to MP3
  }

  const estimatedSize = durationSeconds * bytesPerSecond;
  return Math.ceil(estimatedSize / MAX_FILE_SIZE_BYTES);
}

/**
 * Merge transcription results from multiple chunks
 * Adjusts timestamps based on chunk offsets
 */
export function mergeChunkedTranscriptions(
  results: { result: TranscriptionResult; offsetSeconds: number }[]
): TranscriptionResult {
  if (results.length === 0) {
    throw new Error('No transcription results to merge');
  }

  if (results.length === 1) {
    return results[0].result;
  }

  // Sort by offset
  results.sort((a, b) => a.offsetSeconds - b.offsetSeconds);

  // Merge segments with adjusted timestamps
  const allSegments: TranscriptSegment[] = [];
  let totalDuration = 0;
  const rawTextParts: string[] = [];

  for (const { result, offsetSeconds } of results) {
    for (const segment of result.segments) {
      allSegments.push({
        ...segment,
        start: segment.start + offsetSeconds,
      });
    }
    totalDuration = Math.max(totalDuration, offsetSeconds + result.duration);
    rawTextParts.push(result.rawText);
  }

  return {
    segments: allSegments,
    language: results[0].result.language,
    duration: totalDuration,
    rawText: rawTextParts.join(' '),
  };
}

/**
 * Validate audio file before transcription
 */
export function validateAudioFile(file: File | Blob): { valid: boolean; error?: string } {
  // Check if file exists
  if (!file) {
    return { valid: false, error: 'No file provided' };
  }

  // Check file size
  if (file.size === 0) {
    return { valid: false, error: 'File is empty' };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 25MB.`
    };
  }

  // Check format if we have a filename
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
 * Get transcription status description
 */
export function getProgressMessage(progress: TranscriptionProgress): string {
  const { stage, progress: pct, currentChunk, totalChunks, message } = progress;

  if (message) return message;

  switch (stage) {
    case 'preparing':
      return 'Preparing audio for transcription...';
    case 'transcribing':
      if (currentChunk && totalChunks) {
        return `Transcribing audio (chunk ${currentChunk}/${totalChunks})...`;
      }
      return 'Transcribing audio...';
    case 'processing':
      return 'Processing transcription results...';
    default:
      return `Processing... ${pct}%`;
  }
}

export const WhisperClient = {
  transcribeAudio,
  transcribeAudioFromUrl,
  validateAudioFile,
  isSupportedFormat,
  estimateCostCents,
  estimateProcessingTime,
  estimateChunks,
  mergeChunkedTranscriptions,
  getProgressMessage,
};

export default WhisperClient;
