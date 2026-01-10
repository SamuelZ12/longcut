/**
 * Cobalt API Client for YouTube Audio Extraction
 *
 * Cobalt (cobalt.tools) is a free, open-source media downloader API
 * that supports YouTube audio extraction without requiring authentication.
 *
 * API Documentation: https://github.com/imputnet/cobalt
 */

const COBALT_API_URL = 'https://api.cobalt.tools';

interface CobaltRequest {
  url: string;
  downloadMode?: 'auto' | 'audio' | 'mute';
  audioFormat?: 'best' | 'mp3' | 'ogg' | 'wav' | 'opus';
  audioBitrate?: '320' | '256' | '128' | '96' | '64' | '8';
  filenameStyle?: 'classic' | 'pretty' | 'basic' | 'nerdy';
}

interface CobaltSuccessResponse {
  status: 'tunnel' | 'redirect' | 'picker';
  url?: string;
  filename?: string;
  picker?: Array<{
    type: 'video' | 'audio' | 'photo' | 'gif';
    url: string;
    thumb?: string;
  }>;
}

interface CobaltErrorResponse {
  status: 'error';
  error: {
    code: string;
    context?: {
      service?: string;
    };
  };
}

type CobaltResponse = CobaltSuccessResponse | CobaltErrorResponse;

export interface AudioExtractionResult {
  audioBuffer: ArrayBuffer;
  filename: string;
  contentType: string;
  size: number;
}

export interface AudioUrlResult {
  url: string;
  filename: string;
}

/**
 * Error codes from Cobalt API
 */
export const CobaltErrorCodes = {
  INVALID_URL: 'error.api.link.invalid',
  UNSUPPORTED_SERVICE: 'error.api.service.unsupported',
  CONTENT_UNAVAILABLE: 'error.api.content.unavailable',
  RATE_LIMITED: 'error.api.rate_exceeded',
  FETCH_FAILED: 'error.api.fetch.fail',
  YOUTUBE_AGE_RESTRICTED: 'error.api.youtube.age_restricted',
  YOUTUBE_LOGIN_REQUIRED: 'error.api.youtube.login_required',
} as const;

/**
 * Extract audio URL from a YouTube video
 *
 * @param youtubeId - YouTube video ID
 * @returns Object containing the audio download URL
 */
export async function getYouTubeAudioUrl(youtubeId: string): Promise<AudioUrlResult> {
  const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`;

  const requestBody: CobaltRequest = {
    url: youtubeUrl,
    downloadMode: 'audio',
    audioFormat: 'mp3',
    audioBitrate: '128', // Balance between quality and file size
    filenameStyle: 'basic',
  };

  const response = await fetch(`${COBALT_API_URL}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new Error(`Cobalt API request failed: ${response.status} ${response.statusText}`);
  }

  const data: CobaltResponse = await response.json();

  if (data.status === 'error') {
    const errorCode = data.error.code;
    const errorMessage = getErrorMessage(errorCode);
    throw new Error(`Cobalt API error: ${errorMessage} (${errorCode})`);
  }

  if (data.status === 'picker' && data.picker && data.picker.length > 0) {
    // Find audio option in picker
    const audioOption = data.picker.find(p => p.type === 'audio');
    if (audioOption) {
      return {
        url: audioOption.url,
        filename: `${youtubeId}.mp3`,
      };
    }
  }

  if ((data.status === 'tunnel' || data.status === 'redirect') && data.url) {
    return {
      url: data.url,
      filename: data.filename || `${youtubeId}.mp3`,
    };
  }

  throw new Error('Cobalt API returned unexpected response format');
}

/**
 * Extract and download audio from a YouTube video
 *
 * @param youtubeId - YouTube video ID
 * @returns Audio buffer and metadata
 */
export async function extractYouTubeAudio(youtubeId: string): Promise<AudioExtractionResult> {
  // First, get the audio URL
  const { url, filename } = await getYouTubeAudioUrl(youtubeId);

  // Then download the audio
  const audioResponse = await fetch(url);

  if (!audioResponse.ok) {
    throw new Error(`Failed to download audio: ${audioResponse.status} ${audioResponse.statusText}`);
  }

  const contentType = audioResponse.headers.get('content-type') || 'audio/mpeg';
  const contentLength = audioResponse.headers.get('content-length');

  const audioBuffer = await audioResponse.arrayBuffer();

  return {
    audioBuffer,
    filename,
    contentType,
    size: contentLength ? parseInt(contentLength, 10) : audioBuffer.byteLength,
  };
}

/**
 * Create a File object from audio buffer for Whisper API
 *
 * @param result - Audio extraction result
 * @returns File object ready for Whisper API
 */
export function createAudioFile(result: AudioExtractionResult): File {
  const blob = new Blob([result.audioBuffer], { type: result.contentType });
  return new File([blob], result.filename, { type: result.contentType });
}

/**
 * Get human-readable error message for Cobalt error codes
 */
function getErrorMessage(code: string): string {
  switch (code) {
    case CobaltErrorCodes.INVALID_URL:
      return 'Invalid YouTube URL';
    case CobaltErrorCodes.UNSUPPORTED_SERVICE:
      return 'This service is not supported';
    case CobaltErrorCodes.CONTENT_UNAVAILABLE:
      return 'Video is unavailable or private';
    case CobaltErrorCodes.RATE_LIMITED:
      return 'Rate limit exceeded, please try again later';
    case CobaltErrorCodes.FETCH_FAILED:
      return 'Failed to fetch video data';
    case CobaltErrorCodes.YOUTUBE_AGE_RESTRICTED:
      return 'Video is age-restricted';
    case CobaltErrorCodes.YOUTUBE_LOGIN_REQUIRED:
      return 'Video requires YouTube login';
    default:
      return 'Unknown error occurred';
  }
}

/**
 * Check if audio extraction is likely to succeed
 * (Does a lightweight check without downloading)
 */
export async function canExtractAudio(youtubeId: string): Promise<{ canExtract: boolean; error?: string }> {
  try {
    await getYouTubeAudioUrl(youtubeId);
    return { canExtract: true };
  } catch (error) {
    return {
      canExtract: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
