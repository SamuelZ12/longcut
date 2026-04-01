/**
 * YouTube Transcript Provider — fetches captions directly from YouTube
 * without needing a paid API key.
 *
 * HOW IT WORKS:
 * 1. Scrapes the YouTube watch page to extract YouTube's own internal API key
 *    (this is a public key embedded in every YouTube page, not a personal key)
 * 2. Uses that key to call YouTube's InnerTube Player API, pretending to be
 *    a legitimate YouTube client (Android app, web browser, or iOS app)
 * 3. The API response includes URLs to download the actual caption tracks
 * 4. Downloads and parses the caption XML into transcript segments
 *
 * WHY MULTIPLE CLIENTS:
 * YouTube actively blocks automated requests from server IPs. Different client
 * identities have different bot-detection thresholds. If one gets blocked,
 * we try the next. Think of it as having three disguises.
 *
 * FALLBACK CHAIN: Android → Web → iOS
 *
 * Based on the approach from github.com/JimLiu/baoyu-skills
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result returned to the transcript route — matches the existing interface */
export interface TranscriptFetchResult {
  segments: { text: string; start: number; duration: number }[];
  language?: string;
  availableLanguages: string[];
}

/** What went wrong — helps us decide whether to retry with a different client */
export type TranscriptErrorCode =
  | 'BOT_DETECTED'         // YouTube thinks we're a bot
  | 'AGE_RESTRICTED'       // Video needs login for age verification
  | 'VIDEO_UNAVAILABLE'    // Deleted, private, or region-locked
  | 'TRANSCRIPTS_DISABLED' // Video has no captions at all
  | 'NO_TRANSCRIPT'        // Requested language not available
  | 'IP_BLOCKED'           // Rate limited (429) or reCAPTCHA
  | 'PAGE_FETCH_FAILED'    // Couldn't extract API key from page HTML
  | 'INNERTUBE_REJECTED'   // InnerTube API returned an error
  | 'CAPTION_FETCH_FAILED' // Got caption URL but couldn't download it
  | 'UNKNOWN';

export class TranscriptProviderError extends Error {
  code: TranscriptErrorCode;
  constructor(code: TranscriptErrorCode, message: string) {
    super(message);
    this.name = 'TranscriptProviderError';
    this.code = code;
  }
}

// ─── Client Identities ─────────────────────────────────────────────────────
// Each identity mimics a different YouTube client. YouTube's bot detection
// treats them differently, so if one is blocked, another might work.

interface ClientIdentity {
  name: string;
  clientName: string;
  clientVersion: string;
  userAgent: string;
  // Some clients need an API key from the page, others use a hardcoded one
  apiKey?: string;
}

const CLIENTS: ClientIdentity[] = [
  {
    name: 'Android',
    clientName: 'ANDROID',
    clientVersion: '20.10.38',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US; Pixel 8 Pro Build/UD1A.231105.004) gzip',
    apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
  },
  {
    name: 'Web',
    clientName: 'WEB',
    clientVersion: '2.20250326.00.00',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  },
  {
    name: 'iOS',
    clientName: 'IOS',
    clientVersion: '20.10.4',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    apiKey: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
  },
];

// ─── HTML Entity Decoding ───────────────────────────────────────────────────

const NAMED_HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);|&#39;/g, (entity) => NAMED_HTML_ENTITIES[entity] ?? entity);
}

// ─── Page Scraping ──────────────────────────────────────────────────────────
// We need to scrape the YouTube watch page to get the InnerTube API key and
// client version. These are embedded in the page's JavaScript.

interface PageData {
  apiKey: string;
  clientVersion: string;
  visitorData: string;
}

/**
 * Fetches the YouTube watch page and extracts the internal API credentials.
 * Also handles the EU cookie consent page (YouTube shows a consent form
 * instead of the real page if you don't have cookies).
 */
async function scrapeWatchPage(videoId: string): Promise<PageData> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  let html: string;
  try {
    const resp = await fetch(url, { headers, redirect: 'follow' });
    html = await resp.text();
  } catch (err) {
    throw new TranscriptProviderError('PAGE_FETCH_FAILED', `Failed to fetch YouTube page: ${err}`);
  }

  // Handle EU cookie consent — YouTube redirects to a consent page
  // If we detect it, we extract the consent token and re-fetch with a cookie
  if (html.includes('action="https://consent.youtube.com/s"')) {
    console.log('[YT-TRANSCRIPT] Handling EU cookie consent redirect');
    const consentMatch = html.match(/name="v" value="(.*?)"/);
    if (consentMatch) {
      const consentValue = consentMatch[1];
      try {
        const resp2 = await fetch(url, {
          headers: {
            ...headers,
            'Cookie': `CONSENT=YES+${consentValue}`,
          },
          redirect: 'follow',
        });
        html = await resp2.text();
      } catch {
        // If consent retry fails, continue with the original HTML
      }
    }
  }

  // Extract the three values we need from the page's JavaScript
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  const clientVersionMatch = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
  const visitorDataMatch = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/);

  if (!apiKeyMatch) {
    // Check if video exists at all
    if (html.includes('"playabilityStatus":{"status":"ERROR"')) {
      throw new TranscriptProviderError('VIDEO_UNAVAILABLE', 'Video is unavailable');
    }
    if (html.includes('Sign in to confirm your age') || html.includes('"LOGIN_REQUIRED"')) {
      throw new TranscriptProviderError('AGE_RESTRICTED', 'Video is age-restricted');
    }
    throw new TranscriptProviderError('PAGE_FETCH_FAILED', 'Could not extract INNERTUBE_API_KEY from page');
  }

  return {
    apiKey: apiKeyMatch[1],
    clientVersion: clientVersionMatch?.[1] || '2.20250326.00.00',
    visitorData: visitorDataMatch?.[1] || '',
  };
}

// ─── InnerTube API ──────────────────────────────────────────────────────────

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  kind?: string; // "asr" = auto-generated
}

/**
 * Calls YouTube's InnerTube Player API to get video metadata including caption tracks.
 * This is the same API that YouTube's own apps use internally.
 */
async function fetchInnerTubePlayer(
  videoId: string,
  client: ClientIdentity,
  pageData: PageData | null
): Promise<CaptionTrack[]> {
  // Use the client's hardcoded API key, or the one scraped from the page
  const apiKey = client.apiKey || pageData?.apiKey;
  if (!apiKey) {
    throw new TranscriptProviderError('PAGE_FETCH_FAILED', `No API key available for ${client.name} client`);
  }

  const endpoint = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`;

  // Build the request body — mimics what YouTube's own clients send
  const body: Record<string, unknown> = {
    videoId,
    context: {
      client: {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        userAgent: client.userAgent,
        hl: 'en',
        gl: 'US',
        ...(pageData?.visitorData ? { visitorData: pageData.visitorData } : {}),
      },
    },
  };

  // Android and iOS clients need a "content check OK" flag
  if (client.clientName === 'ANDROID' || client.clientName === 'IOS') {
    body.contentCheckOk = true;
    body.racyCheckOk = true;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': client.userAgent,
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new TranscriptProviderError('INNERTUBE_REJECTED', `InnerTube request failed for ${client.name}: ${err}`);
  }

  if (response.status === 429) {
    throw new TranscriptProviderError('IP_BLOCKED', `Rate limited (429) with ${client.name} client`);
  }

  if (!response.ok) {
    throw new TranscriptProviderError('INNERTUBE_REJECTED', `InnerTube returned ${response.status} for ${client.name}`);
  }

  let data: Record<string, unknown>;
  try {
    data = await response.json() as Record<string, unknown>;
  } catch {
    throw new TranscriptProviderError('INNERTUBE_REJECTED', `Invalid JSON from InnerTube for ${client.name}`);
  }

  // Check for playability errors
  const playabilityStatus = data.playabilityStatus as Record<string, unknown> | undefined;
  if (playabilityStatus) {
    const status = playabilityStatus.status as string;
    if (status === 'ERROR' || status === 'UNPLAYABLE') {
      throw new TranscriptProviderError('VIDEO_UNAVAILABLE', `Video is ${status.toLowerCase()}`);
    }
    if (status === 'LOGIN_REQUIRED') {
      const reason = (playabilityStatus.reason as string) || '';
      if (reason.includes('age') || reason.includes('Sign in')) {
        throw new TranscriptProviderError('AGE_RESTRICTED', 'Video is age-restricted');
      }
      throw new TranscriptProviderError('BOT_DETECTED', `Login required: ${reason}`);
    }
  }

  // Extract caption tracks from the response
  const captions = data.captions as Record<string, unknown> | undefined;
  if (!captions) {
    throw new TranscriptProviderError('TRANSCRIPTS_DISABLED', 'No captions object in InnerTube response');
  }

  const tracklistRenderer = captions.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  if (!tracklistRenderer) {
    throw new TranscriptProviderError('TRANSCRIPTS_DISABLED', 'No caption tracklist renderer');
  }

  const captionTracks = tracklistRenderer.captionTracks as Array<Record<string, unknown>> | undefined;
  if (!captionTracks || captionTracks.length === 0) {
    throw new TranscriptProviderError('TRANSCRIPTS_DISABLED', 'No caption tracks available');
  }

  // Map raw tracks to our CaptionTrack interface
  return captionTracks
    .filter(t => typeof t.baseUrl === 'string' && typeof t.languageCode === 'string')
    .map(t => {
      // Extract track name from either simpleText or runs format
      const nameObj = t.name as Record<string, unknown> | undefined;
      let name = 'Unknown';
      if (nameObj) {
        if (typeof nameObj.simpleText === 'string') {
          name = nameObj.simpleText;
        } else if (Array.isArray(nameObj.runs)) {
          name = (nameObj.runs as Array<{ text?: string }>)
            .map(r => r.text || '')
            .join('');
        }
      }

      return {
        baseUrl: t.baseUrl as string,
        languageCode: t.languageCode as string,
        kind: typeof t.kind === 'string' ? t.kind : undefined,
        name,
      };
    });
}

// ─── Caption XML Parsing ────────────────────────────────────────────────────

/**
 * Parses YouTube's caption XML format into transcript segments.
 *
 * YouTube uses TWO different XML formats depending on the client/track:
 *
 * Format 1 (newer / fmt=3, used by InnerTube):
 *   <p t="1230" d="4560">Hello world</p>
 *   (timestamps in MILLISECONDS)
 *
 * Format 2 (older / fmt=1):
 *   <text start="1.23" dur="4.56">Hello world</text>
 *   (timestamps in SECONDS)
 */
function parseCaptionXml(xml: string): { text: string; start: number; duration: number }[] {
  const segments: { text: string; start: number; duration: number }[] = [];

  // Helper to clean caption text
  function cleanText(raw: string): string {
    return decodeHtmlEntities(
      raw
        .replace(/<[^>]*>/g, '') // Strip nested HTML tags (e.g. <font>, <s>)
        .replace(/\n/g, ' ')
    ).trim();
  }

  // Try Format 1 first: <p t="ms" d="ms">text</p> (milliseconds)
  const pRegex = /<p\s+t="([^"]*)"(?:\s+d="([^"]*)")?[^>]*>([\s\S]*?)<\/p>/g;
  let match;
  let foundP = false;

  while ((match = pRegex.exec(xml)) !== null) {
    foundP = true;
    // t and d are in milliseconds — divide by 1000 to get seconds
    const start = (parseFloat(match[1]) || 0) / 1000;
    const duration = (parseFloat(match[2]) || 0) / 1000;
    const text = cleanText(match[3] || '');

    if (text) {
      segments.push({ text, start, duration });
    }
  }

  if (foundP) return segments;

  // Fallback to Format 2: <text start="sec" dur="sec">text</text> (seconds)
  const textRegex = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;

  while ((match = textRegex.exec(xml)) !== null) {
    const start = parseFloat(match[1]) || 0;
    const duration = parseFloat(match[2]) || 0;
    const text = cleanText(match[3] || '');

    if (text) {
      segments.push({ text, start, duration });
    }
  }

  return segments;
}

/**
 * Downloads a caption track from the given URL and parses it.
 */
async function fetchCaptionTrack(baseUrl: string): Promise<{ text: string; start: number; duration: number }[]> {
  // Ensure we get XML format
  const url = baseUrl.includes('fmt=') ? baseUrl : `${baseUrl}&fmt=3`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    throw new TranscriptProviderError('CAPTION_FETCH_FAILED', `Failed to download caption track: ${err}`);
  }

  if (!response.ok) {
    throw new TranscriptProviderError('CAPTION_FETCH_FAILED', `Caption track returned ${response.status}`);
  }

  const xml = await response.text();
  return parseCaptionXml(xml);
}

// ─── Language Selection ─────────────────────────────────────────────────────

/**
 * Picks the best caption track based on the user's language preference.
 *
 * Priority:
 * 1. Manual (human-created) captions in the requested language
 * 2. Auto-generated captions in the requested language
 * 3. Manual captions in any language (prefer English)
 * 4. Auto-generated captions in any language (prefer English)
 */
function selectBestTrack(
  tracks: CaptionTrack[],
  preferredLang?: string
): CaptionTrack | null {
  if (tracks.length === 0) return null;

  // Separate manual vs auto-generated tracks
  const manual = tracks.filter(t => t.kind !== 'asr');
  const auto = tracks.filter(t => t.kind === 'asr');

  // Helper: find a track matching a language code
  const findByLang = (list: CaptionTrack[], lang: string) =>
    list.find(t => t.languageCode === lang) ||
    list.find(t => t.languageCode.startsWith(lang.split('-')[0]));

  // If user requested a specific language, try that first
  if (preferredLang) {
    const manualMatch = findByLang(manual, preferredLang);
    if (manualMatch) return manualMatch;
    const autoMatch = findByLang(auto, preferredLang);
    if (autoMatch) return autoMatch;
  }

  // No preference or preferred not found — pick the best available
  if (manual.length > 0) {
    const englishManual = findByLang(manual, 'en');
    return englishManual || manual[0];
  }

  if (auto.length > 0) {
    const englishAuto = findByLang(auto, 'en');
    return englishAuto || auto[0];
  }

  return tracks[0];
}

// ─── Error Classification ───────────────────────────────────────────────────

/**
 * Determines whether we should try the next client identity after an error.
 * Some errors are about THIS client being blocked (try another),
 * while others are about the VIDEO itself (no point retrying).
 */
function shouldTryNextClient(error: TranscriptProviderError): boolean {
  switch (error.code) {
    // Client-specific — a different client might work
    case 'BOT_DETECTED':
    case 'IP_BLOCKED':
    case 'INNERTUBE_REJECTED':
    case 'PAGE_FETCH_FAILED':
      return true;
    // Video-level — no point retrying
    case 'VIDEO_UNAVAILABLE':
    case 'AGE_RESTRICTED':
    case 'TRANSCRIPTS_DISABLED':
    case 'NO_TRANSCRIPT':
      return false;
    default:
      return true;
  }
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Fetches a YouTube video's transcript using the InnerTube API.
 *
 * Tries three client identities in sequence (Android → Web → iOS).
 * Each client mimics a different YouTube app, and YouTube's bot detection
 * treats them differently. If one gets blocked, the next might work.
 *
 * @param videoId - The 11-character YouTube video ID
 * @param preferredLanguage - Optional language code (e.g., 'en', 'zh', 'ja')
 * @param expectedDuration - Optional expected video duration in seconds
 * @returns The transcript segments, language info, and available languages
 */
export async function fetchYouTubeTranscript(
  videoId: string,
  preferredLanguage?: string,
  expectedDuration?: number
): Promise<TranscriptFetchResult | null> {
  // Step 1: Scrape the watch page for InnerTube credentials
  // (needed by the Web client; Android/iOS have hardcoded keys)
  let pageData: PageData | null = null;
  try {
    pageData = await scrapeWatchPage(videoId);
  } catch (err) {
    // Page scraping failed — we can still try Android/iOS with hardcoded keys
    console.warn('[YT-TRANSCRIPT] Page scraping failed, will try with hardcoded keys:', err);
  }

  // Step 2: Try each client identity until one works
  let lastError: TranscriptProviderError | null = null;

  for (const client of CLIENTS) {
    // Web client needs the scraped page data for its API key
    if (client.clientName === 'WEB' && !pageData?.apiKey) {
      console.log(`[YT-TRANSCRIPT] Skipping ${client.name} client — no page data available`);
      continue;
    }

    console.log(`[YT-TRANSCRIPT] Trying ${client.name} client for video ${videoId}`);

    try {
      // Step 2a: Get caption tracks from InnerTube
      const captionTracks = await fetchInnerTubePlayer(videoId, client, pageData);

      console.log(`[YT-TRANSCRIPT] ${client.name} returned ${captionTracks.length} caption tracks:`,
        captionTracks.map(t => `${t.languageCode}${t.kind === 'asr' ? ' (auto)' : ''}`).join(', ')
      );

      // Step 2b: Pick the best track for the requested language
      const selectedTrack = selectBestTrack(captionTracks, preferredLanguage);
      if (!selectedTrack) {
        lastError = new TranscriptProviderError('NO_TRANSCRIPT', 'No suitable caption track found');
        continue;
      }

      console.log(`[YT-TRANSCRIPT] Selected track: ${selectedTrack.languageCode}${selectedTrack.kind === 'asr' ? ' (auto-generated)' : ' (manual)'}`);

      // Step 2c: Download and parse the caption track
      const segments = await fetchCaptionTrack(selectedTrack.baseUrl);

      if (segments.length === 0) {
        lastError = new TranscriptProviderError('CAPTION_FETCH_FAILED', 'Caption track returned empty');
        continue;
      }

      console.log(`[YT-TRANSCRIPT] Successfully fetched ${segments.length} segments via ${client.name} client`);

      // Build the list of available languages from the caption tracks
      const availableLanguages = [...new Set(captionTracks.map(t => t.languageCode))];

      return {
        segments,
        language: selectedTrack.languageCode,
        availableLanguages,
      };

    } catch (err) {
      if (err instanceof TranscriptProviderError) {
        lastError = err;
        console.warn(`[YT-TRANSCRIPT] ${client.name} client failed:`, err.code, err.message);

        // If this error means the video itself is the problem, don't try other clients
        if (!shouldTryNextClient(err)) {
          return null;
        }
      } else {
        lastError = new TranscriptProviderError('UNKNOWN', `${client.name} client threw: ${err}`);
        console.warn(`[YT-TRANSCRIPT] ${client.name} client threw unexpected error:`, err);
      }
    }
  }

  // All clients failed
  if (lastError) {
    console.error(`[YT-TRANSCRIPT] All clients failed for ${videoId}. Last error:`, lastError.code, lastError.message);
  }
  return null;
}
