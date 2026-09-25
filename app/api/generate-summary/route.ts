import { NextRequest, NextResponse } from 'next/server';
import { withInitialAnalysis } from '@/lib/initial-analysis-spend';
import { TranscriptSegment, VideoInfo } from '@/lib/types';
import { withSecurity } from '@/lib/security-middleware';
import { RATE_LIMITS } from '@/lib/rate-limiter';
import { generateAIResponse } from '@/lib/ai-client';
import { summaryTakeawaysSchema } from '@/lib/schemas';
import { normalizeTimestampSources } from '@/lib/timestamp-normalization';
import { buildTakeawaysPrompt } from '@/lib/prompts/takeaways';
import { getLanguageName } from '@/lib/language-utils';
import { safeJsonParse } from '@/lib/json-utils';

type StructuredTakeaway = {
  label: string;
  insight: string;
  timestamps: string[];
};

const TAKEAWAYS_HEADING = '## Key takeaways';

function normalizeTakeawaysPayload(payload: unknown): StructuredTakeaway[] {
  const candidateArray = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.takeaways)
      ? (payload as any).takeaways
      : Array.isArray((payload as any)?.items)
        ? (payload as any).items
        : [];

  const normalized: StructuredTakeaway[] = [];

  for (const item of candidateArray) {
    // Handle case where AI returns array of JSON strings instead of objects
    // e.g., ["{\"label\":\"...\",\"insight\":\"...\"}", ...] instead of [{label: "...", insight: "..."}, ...]
    let parsedItem = item;
    if (typeof item === 'string') {
      try {
        parsedItem = JSON.parse(item);
      } catch {
        continue; // Skip if not valid JSON string
      }
    }

    if (!parsedItem || typeof parsedItem !== 'object') {
      continue;
    }

    const rawLabel = typeof (parsedItem as any).label === 'string'
      ? (parsedItem as any).label
      : typeof (parsedItem as any).title === 'string'
        ? (parsedItem as any).title
        : '';

    const rawInsight = typeof (parsedItem as any).insight === 'string'
      ? (parsedItem as any).insight
      : typeof (parsedItem as any).summary === 'string'
        ? (parsedItem as any).summary
        : typeof (parsedItem as any).description === 'string'
          ? (parsedItem as any).description
          : '';

    const timestampSources: unknown[] = [];

    if (Array.isArray((parsedItem as any).timestamps)) {
      timestampSources.push(...(parsedItem as any).timestamps);
    }

    if (typeof (parsedItem as any).timestamp === 'string') {
      timestampSources.push((parsedItem as any).timestamp);
    }

    if (typeof (parsedItem as any).time === 'string') {
      timestampSources.push((parsedItem as any).time);
    }

    const uniqueTimestamps = normalizeTimestampSources(timestampSources, { limit: 2 });

    const label = rawLabel.trim();
    const insight = rawInsight.trim();

    if (!label || !insight || uniqueTimestamps.length === 0) {
      continue;
    }

    normalized.push({
      label,
      insight,
      timestamps: uniqueTimestamps
    });

    if (normalized.length === 6) {
      break;
    }
  }

  return normalized;
}

/**
 * Recovers partial takeaways from malformed JSON responses.
 * Extracts complete objects even when the array is truncated or malformed.
 * Also handles double-encoded JSON (array of JSON strings).
 * Pattern: {"label":"...","insight":"...","timestamps":[...]}
 *
 * @param raw - Raw response that may contain partial JSON
 * @returns Array of recovered takeaways or null if recovery fails
 */
function recoverPartialTakeaways(raw: string): StructuredTakeaway[] | null {
  const takeaways: StructuredTakeaway[] = [];

  // First, try to handle the case where raw is an array of JSON strings (double-encoded)
  // e.g., ["{\"label\":\"...\",\"insight\":\"...\",\"timestamps\":[...]}", ...]
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.includes('\\"label\\"')) {
      // Likely an array of JSON strings - try to parse and extract
      const outerArray = JSON.parse(trimmed);
      if (Array.isArray(outerArray)) {
        for (const item of outerArray) {
          if (typeof item === 'string') {
            try {
              const parsed = JSON.parse(item);
              if (parsed && typeof parsed === 'object') {
                const label = typeof parsed.label === 'string' ? parsed.label.trim() : '';
                const insight = typeof parsed.insight === 'string' ? parsed.insight.trim() : '';
                const timestamps = Array.isArray(parsed.timestamps)
                  ? parsed.timestamps
                      .filter((ts: unknown): ts is string => typeof ts === 'string')
                      .map((ts: string) => ts.trim())
                      .filter((ts: string) => ts.length > 0)
                      .slice(0, 2)
                  : [];

                if (label && insight && timestamps.length > 0) {
                  takeaways.push({ label, insight, timestamps });
                  if (takeaways.length >= 6) break;
                }
              }
            } catch {
              // Skip unparseable string items
              continue;
            }
          }
        }

        if (takeaways.length >= 4) {
          return takeaways;
        }
      }
    }
  } catch {
    // Fall through to regex-based recovery
  }

  // Regex-based recovery for truncated/malformed JSON
  // Pattern matches complete objects with all required fields
  // Handles both single and double quotes, escaped characters
  const objectPattern = /\{\s*"label"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"\s*,\s*"insight"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"\s*,\s*"timestamps"\s*:\s*\[(.*?)\]\s*\}/g;

  let match;
  while ((match = objectPattern.exec(raw)) !== null) {
    try {
      // Extract matched groups (accounting for escaped characters)
      const labelRaw = match[1];
      const insightRaw = match[3];
      const timestampsStr = match[5];

      // Decode escaped characters
      const label = JSON.parse(`"${labelRaw}"`);
      const insight = JSON.parse(`"${insightRaw}"`);

      // Extract timestamps from array string
      const timestampMatches = timestampsStr.match(/"([^"]+)"/g);
      if (!timestampMatches || timestampMatches.length === 0) {
        continue;
      }

      const timestamps = timestampMatches
        .map(ts => ts.replace(/"/g, '').trim())
        .filter(ts => ts.length > 0)
        .slice(0, 2); // Max 2 per schema

      if (timestamps.length === 0) {
        continue;
      }

      takeaways.push({
        label: label.trim(),
        insight: insight.trim(),
        timestamps
      });

      if (takeaways.length >= 6) {
        break; // Max 6 per schema
      }
    } catch {
      // Skip malformed objects
      continue;
    }
  }

  // Only return if we have minimum required (4)
  return takeaways.length >= 4 ? takeaways : null;
}

function buildTakeawaysMarkdown(takeaways: StructuredTakeaway[]): string {
  const lines = [TAKEAWAYS_HEADING];

  for (const item of takeaways) {
    const label = item.label.trim().replace(/\s+/g, ' ');
    const insight = item.insight.trim();
    const timestampItems = item.timestamps
      .map(ts => ts.trim())
      .filter(Boolean)
      .map(ts => `[${ts}]`);

    const timestampSuffix = timestampItems.length > 0
      ? ` ${timestampItems.join(', ')}`
      : '';
    lines.push(`- **${label}**: ${insight}${timestampSuffix}`);
  }

  return lines.join('\n');
}

async function handler(request: NextRequest) {
  try {
    const { transcript, videoInfo, targetLanguage } = await request.json();

    if (!transcript || !Array.isArray(transcript)) {
      return NextResponse.json(
        { error: 'Valid transcript is required' },
        { status: 400 }
      );
    }

    if (!videoInfo || !videoInfo.title) {
      return NextResponse.json(
        { error: 'Video information is required' },
        { status: 400 }
      );
    }

    const basePrompt = buildTakeawaysPrompt({
      transcript: transcript as TranscriptSegment[],
      videoInfo: videoInfo as Partial<VideoInfo>
    });

    // Build language instruction if targetLanguage is provided
    const languageInstruction = targetLanguage
      ? (() => {
          const langName = getLanguageName(targetLanguage);
          return `\n<languageRequirement>IMPORTANT: You MUST respond in ${langName}. All text in the "label" and "insight" fields must be in ${langName}.</languageRequirement>\n`;
        })()
      : '';

    const prompt = basePrompt.replace('</task>', `${languageInstruction}</task>`);

    let response: string;

    try {
      response = await generateAIResponse(prompt, {
        temperature: 0.6,
        zodSchema: summaryTakeawaysSchema
      });

      // Diagnostic logging for debugging JSON parsing issues
      console.log('=== SUMMARY AI RAW RESPONSE ===');
      console.log('Length:', response.length, 'Type:', typeof response);
      console.log('First 100 bytes (hex):', Buffer.from(response.slice(0, 100)).toString('hex'));
      console.log('First 500 chars:', response.slice(0, 500));
      console.log('Last 200 chars:', response.slice(-200));
      console.log('Has BOM:', response.charCodeAt(0) === 0xFEFF);
      console.log('=== END RAW RESPONSE ===');
    } catch (error) {
      console.error('Error generating summary:', error);
      throw new Error('No response from AI model');
    }

    if (!response) {
      throw new Error('No response from AI model');
    }

    let takeaways: StructuredTakeaway[];

    // Stage 1: Direct parse with preprocessing (via safeJsonParse)
    try {
      console.log('[Stage 1] Attempting direct parse with preprocessing...');
      const parsed = safeJsonParse(response);
      const normalized = normalizeTakeawaysPayload(parsed);

      const validation = summaryTakeawaysSchema.safeParse(normalized);
      if (!validation.success) {
        console.error('[Stage 1] Validation failed:', validation.error.flatten());
        throw new Error('Normalized takeaways did not match expected schema');
      }

      takeaways = validation.data as StructuredTakeaway[];
      console.log('[Stage 1] Successfully parsed response');
    } catch (stage1Error) {
      console.log('[Stage 1] Failed:', stage1Error instanceof Error ? stage1Error.message : 'Unknown');

      // Stage 2: Partial recovery from truncated/malformed JSON
      try {
        console.log('[Stage 2] Attempting partial recovery...');
        const recovered = recoverPartialTakeaways(response);

        if (recovered && recovered.length >= 4) {
          const validation = summaryTakeawaysSchema.safeParse(recovered);
          if (!validation.success) {
            console.error('[Stage 2] Validation failed:', validation.error.flatten());
            throw stage1Error;
          }

          takeaways = validation.data as StructuredTakeaway[];
          console.log(`[Stage 2] Successfully recovered ${takeaways.length} takeaways`);
        } else {
          console.log('[Stage 2] Insufficient valid objects recovered');
          throw stage1Error;
        }
      } catch (stage2Error) {
        console.error('[Stage 2] Recovery failed:', stage2Error instanceof Error ? stage2Error.message : 'Unknown');
        console.error('Original error:', stage1Error);
        throw new Error('Invalid response format from AI model');
      }
    }

    if (!takeaways.length) {
      throw new Error('AI model returned no takeaways');
    }

    const markdown = buildTakeawaysMarkdown(takeaways);

    return NextResponse.json({ summaryContent: markdown });
  } catch (error) {
    console.error('Error generating summary:', error);
    return NextResponse.json(
      { error: 'Failed to generate summary' },
      { status: 500 }
    );
  }
}

// Apply security with generation rate limits
export const POST = withSecurity(withInitialAnalysis('summary', handler), {
  paidWork: true,
  rateLimit: RATE_LIMITS.AUTH_GENERATION, // Use authenticated rate limit
  maxBodySize: 10 * 1024 * 1024, // 10MB for large transcripts
  allowedMethods: ['POST']
});
