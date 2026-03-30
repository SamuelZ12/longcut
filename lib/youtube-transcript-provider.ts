interface CaptionTrackName {
  simpleText?: string;
  runs?: Array<{ text?: string }>;
}

interface CaptionTrackRenderer {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: CaptionTrackName;
}

interface CaptionTrackListRenderer {
  captionTracks?: CaptionTrackRenderer[];
}

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: CaptionTrackListRenderer;
  };
}

interface CaptionEvent {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name: string;
}

export interface CaptionJsonResponse {
  events?: CaptionEvent[];
}

export interface TranscriptFetchResult {
  segments: { text: string; start: number; duration: number }[];
  language?: string;
  availableLanguages: string[];
}

export class TranscriptProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptProviderError';
  }
}

const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const ANDROID_CLIENT_VERSION = '20.10.38';
const ANDROID_USER_AGENT = `com.google.android.youtube/${ANDROID_CLIENT_VERSION} (Linux; U; Android 14)`;

const PLAYER_RESPONSE_MARKERS = [
  'var ytInitialPlayerResponse =',
  'ytInitialPlayerResponse =',
  'window["ytInitialPlayerResponse"] =',
  'window[\'ytInitialPlayerResponse\'] =',
];

const NAMED_HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|nbsp);|&#39;/g, (entity) => NAMED_HTML_ENTITIES[entity] ?? entity);
}

function normalizeLanguageCode(code: string): string {
  return code.trim().toLowerCase();
}

function getLanguageRoot(code: string): string {
  return normalizeLanguageCode(code).split(/[-_]/)[0] ?? normalizeLanguageCode(code);
}

function isManualTrack(track: CaptionTrack): boolean {
  return track.kind !== 'asr';
}

function extractTrackName(name?: CaptionTrackName): string {
  if (!name) return 'Unknown';
  if (typeof name.simpleText === 'string' && name.simpleText.trim()) {
    return name.simpleText.trim();
  }

  const combined = name.runs
    ?.map((run) => run.text?.trim() ?? '')
    .join('')
    .trim();

  return combined || 'Unknown';
}

function extractJsonObjectAfterMarker(html: string, marker: string): string | null {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;

  const objectStart = html.indexOf('{', markerIndex + marker.length);
  if (objectStart === -1) return null;

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = objectStart; index < html.length; index++) {
    const character = html[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (character === '\\') {
        isEscaped = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{') {
      depth += 1;
      continue;
    }

    if (character === '}') {
      depth -= 1;

      if (depth === 0) {
        return html.slice(objectStart, index + 1);
      }
    }
  }

  return null;
}

function extractPlayerResponse(html: string): PlayerResponse | null {
  for (const marker of PLAYER_RESPONSE_MARKERS) {
    const jsonText = extractJsonObjectAfterMarker(html, marker);
    if (!jsonText) continue;

    try {
      return JSON.parse(jsonText) as PlayerResponse;
    } catch {
      continue;
    }
  }

  return null;
}

function dedupeTracks(tracks: CaptionTrack[]): CaptionTrack[] {
  const seen = new Set<string>();

  return tracks.filter((track) => {
    const key = `${track.languageCode}:${track.kind ?? 'manual'}:${track.baseUrl}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function mapCaptionTracks(rawTracks: CaptionTrackRenderer[] | undefined): CaptionTrack[] {
  if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
    return [];
  }

  return dedupeTracks(
    rawTracks.flatMap((track) => {
      if (typeof track.baseUrl !== 'string' || typeof track.languageCode !== 'string') {
        return [];
      }

      return [{
        baseUrl: track.baseUrl,
        languageCode: track.languageCode,
        kind: typeof track.kind === 'string' ? track.kind : undefined,
        name: extractTrackName(track.name),
      }];
    })
  );
}

function extractCaptionTracksFromPlayerResponse(playerResponse: PlayerResponse | null): CaptionTrack[] {
  return mapCaptionTracks(playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
}

export function extractCaptionTracksFromWatchHtml(html: string): CaptionTrack[] {
  const playerResponse = extractPlayerResponse(html);
  return extractCaptionTracksFromPlayerResponse(playerResponse);
}

function getTrackPriority(track: CaptionTrack, preferredLanguage?: string): number {
  let score = isManualTrack(track) ? 10 : 0;

  if (!preferredLanguage) {
    return getLanguageRoot(track.languageCode) === 'en' ? score + 100 : score;
  }

  const normalizedPreferredLanguage = normalizeLanguageCode(preferredLanguage);
  const normalizedTrackLanguage = normalizeLanguageCode(track.languageCode);

  if (normalizedTrackLanguage === normalizedPreferredLanguage) {
    score += 200;
  } else if (getLanguageRoot(track.languageCode) === getLanguageRoot(preferredLanguage)) {
    score += 150;
  } else if (getLanguageRoot(track.languageCode) === 'en') {
    score += 100;
  }

  return score;
}

export function buildCaptionTrackCandidates(
  tracks: CaptionTrack[],
  preferredLanguage?: string
): CaptionTrack[] {
  return [...tracks]
    .map((track, index) => ({ track, index }))
    .sort((left, right) => {
      const priorityDifference = getTrackPriority(right.track, preferredLanguage) - getTrackPriority(left.track, preferredLanguage);
      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      return left.index - right.index;
    })
    .map(({ track }) => track);
}

export function transformCaptionJsonToSegments(payload: CaptionJsonResponse): { text: string; start: number; duration: number }[] {
  if (!Array.isArray(payload.events) || payload.events.length === 0) {
    return [];
  }

  return payload.events.flatMap((event) => {
    if (!Array.isArray(event.segs) || event.segs.length === 0) {
      return [];
    }

    const text = decodeHtmlEntities(
      event.segs
        .map((segment) => segment.utf8 ?? '')
        .join('')
        .replace(/\n/g, ' ')
        .trim()
    ).trim();

    if (!text) {
      return [];
    }

    return [{
      text,
      start: (event.tStartMs ?? 0) / 1000,
      duration: Math.max((event.dDurationMs ?? 0) / 1000, 0),
    }];
  });
}

export function transformCaptionXmlToSegments(xmlText: string): { text: string; start: number; duration: number }[] {
  const srvSegments: { text: string; start: number; duration: number }[] = [];
  const srvParagraphRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;

  while ((match = srvParagraphRegex.exec(xmlText)) !== null) {
    const paragraphBody = match[3].replace(/<br\s*\/?>/gi, ' ');
    const segmentMatches = [...paragraphBody.matchAll(/<s[^>]*>([\s\S]*?)<\/s>/g)];
    const rawText = segmentMatches.length > 0
      ? segmentMatches.map((segment) => segment[1]).join('')
      : paragraphBody.replace(/<[^>]+>/g, '');
    const text = decodeHtmlEntities(rawText).trim();

    if (!text) {
      continue;
    }

    srvSegments.push({
      text,
      start: parseInt(match[1], 10) / 1000,
      duration: parseInt(match[2], 10) / 1000,
    });
  }

  if (srvSegments.length > 0) {
    return srvSegments;
  }

  const legacySegments: { text: string; start: number; duration: number }[] = [];
  const legacyTextRegex = /<text\s+start="([^"]*)"\s+dur="([^"]*)">([\s\S]*?)<\/text>/g;

  while ((match = legacyTextRegex.exec(xmlText)) !== null) {
    const text = decodeHtmlEntities(match[3]).trim();
    if (!text) {
      continue;
    }

    legacySegments.push({
      text,
      start: parseFloat(match[1]),
      duration: parseFloat(match[2]),
    });
  }

  return legacySegments;
}

function calculateTranscriptDuration(segments: { start: number; duration: number }[]): number {
  if (segments.length === 0) {
    return 0;
  }

  const lastSegment = segments[segments.length - 1];
  return lastSegment.start + lastSegment.duration;
}

function dedupeLanguages(tracks: CaptionTrack[]): string[] {
  const seen = new Set<string>();

  return tracks.flatMap((track) => {
    const normalized = normalizeLanguageCode(track.languageCode);
    if (seen.has(normalized)) {
      return [];
    }

    seen.add(normalized);
    return [track.languageCode];
  });
}

async function fetchWatchHtml(videoId: string): Promise<string> {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&persist_hl=1`, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Failed to load YouTube watch page (${response.status})`);
  }

  return response.text();
}

async function fetchCaptionTracksFromInnerTube(videoId: string): Promise<CaptionTrack[]> {
  const response = await fetch(INNERTUBE_PLAYER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': ANDROID_USER_AGENT,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: ANDROID_CLIENT_VERSION,
        },
      },
      videoId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to load YouTube player data (${response.status})`);
  }

  const playerResponse = (await response.json()) as PlayerResponse;
  return extractCaptionTracksFromPlayerResponse(playerResponse);
}

async function fetchTrackSegments(track: CaptionTrack): Promise<{ text: string; start: number; duration: number }[]> {
  const response = await fetch(track.baseUrl, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36,gzip(gfe)',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Failed to load caption track (${response.status})`);
  }

  const xmlText = await response.text();
  if (!xmlText.trim()) {
    throw new Error('Caption track response was empty');
  }

  return transformCaptionXmlToSegments(xmlText);
}

export async function fetchYouTubeTranscript(
  videoId: string,
  preferredLanguage?: string,
  expectedDuration?: number
): Promise<TranscriptFetchResult | null> {
  let tracks: CaptionTrack[] = [];

  try {
    tracks = await fetchCaptionTracksFromInnerTube(videoId);
  } catch (error) {
    console.warn('[TRANSCRIPT] Failed to fetch caption tracks via InnerTube', {
      videoId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (tracks.length === 0) {
    const watchHtml = await fetchWatchHtml(videoId);
    tracks = extractCaptionTracksFromWatchHtml(watchHtml);
  }

  if (tracks.length === 0) {
    return null;
  }

  const candidates = buildCaptionTrackCandidates(tracks, preferredLanguage);
  const availableLanguages = dedupeLanguages(tracks);
  const isPreferredMatch = (languageCode: string) => (
    !!preferredLanguage && getLanguageRoot(languageCode) === getLanguageRoot(preferredLanguage)
  );
  let bestMatch: {
    track: CaptionTrack;
    segments: { text: string; start: number; duration: number }[];
    duration: number;
  } | null = null;
  let hadTrackFetchError = false;

  for (const track of candidates) {
    if (preferredLanguage && !isPreferredMatch(track.languageCode)) {
      continue;
    }

    try {
      const segments = await fetchTrackSegments(track);
      if (segments.length === 0) {
        continue;
      }

      const duration = calculateTranscriptDuration(segments);

      if (preferredLanguage) {
        return {
          segments,
          language: track.languageCode,
          availableLanguages,
        };
      }

      if (!bestMatch || duration > bestMatch.duration) {
        bestMatch = { track, segments, duration };
      }

      const meetsCoverageThreshold = expectedDuration
        ? duration >= expectedDuration * 0.5
        : duration >= 300 || candidates.length === 1;

      if (meetsCoverageThreshold) {
        break;
      }
    } catch (error) {
      hadTrackFetchError = true;
      console.warn('[TRANSCRIPT] Failed to fetch caption track', {
        videoId,
        languageCode: track.languageCode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (preferredLanguage && hadTrackFetchError) {
    throw new TranscriptProviderError(`Failed to fetch transcript for requested language: ${preferredLanguage}`);
  }

  if (!bestMatch) {
    if (hadTrackFetchError) {
      throw new TranscriptProviderError('All caption track fetches failed');
    }

    return null;
  }

  return {
    segments: bestMatch.segments,
    language: bestMatch.track.languageCode,
    availableLanguages,
  };
}
