import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { generateAIResponse } from '@/lib/ai-client';
import { safeJsonParse } from '@/lib/json-utils';
import {
  consumeVideoCreditAtomic,
  canGenerateVideo,
} from '@/lib/subscription-manager';
import { youtubeIdSchema, transcriptSchema, videoInfoSchema } from '@/lib/validation';

// Define the request schema for validation
const enhanceTranscriptSchema = z.object({
  videoId: youtubeIdSchema,
  videoInfo: videoInfoSchema,
  transcript: transcriptSchema,
});

// Define the response schema from AI to ensure strict JSON output
const aiResponseSchema = z.object({
  enhancedSegments: z.array(z.string()),
});

// Chunking configuration for large transcripts
const CHUNK_SIZE = 100; // segments per chunk
const SMALL_TRANSCRIPT_THRESHOLD = 150; // Process in single request if <= this

/**
 * Split an array into chunks of specified size
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Build the system prompt for enhancing a chunk of transcript segments
 */
function buildEnhancePrompt(
  rawTexts: string[],
  videoInfo: { title: string; author?: string | null; description?: string | null },
  chunkIndex: number,
  totalChunks: number
): string {
  const chunkInfo = totalChunks > 1
    ? `- Processing chunk ${chunkIndex + 1} of ${totalChunks}\n`
    : '';

  return `
You are an expert transcript editor. Your task is to enhance the accuracy and readability of a video transcript while maintaining a strict 1:1 mapping with the input segments.

Context:
- Video Title: "${videoInfo.title}"
- Channel/Author: "${videoInfo.author || 'Unknown'}"
- Description: "${videoInfo.description?.slice(0, 500) || 'N/A'}"
${chunkInfo}
Instructions:
1.  Read the input array of strings. Each string corresponds to a specific time segment.
2.  Clean up filler words (um, uh, like, etc.), fix grammar, punctuation, and capitalization.
3.  Fix specific terms based on context (e.g., technical terms, proper nouns).
4.  Identify speakers if clear from context, but prioritize flow and readability.
5.  **CRITICAL:** You MUST return an array of strings called "enhancedSegments".
6.  **CRITICAL:** The "enhancedSegments" array MUST have exactly ${rawTexts.length} elements. Index 0 of output must correspond to Index 0 of input.
7.  Do not merge or split segments across indices. If a sentence spans multiple segments, ensure the split points remain roughly the same or flow naturally across the boundary.

Input Segments (${rawTexts.length} total):
${JSON.stringify(rawTexts)}
`;
}

/**
 * Process a single chunk of transcript segments with AI enhancement
 */
async function processEnhanceChunk(
  rawTexts: string[],
  videoInfo: { title: string; author?: string | null; description?: string | null },
  chunkIndex: number,
  totalChunks: number
): Promise<string[]> {
  const prompt = buildEnhancePrompt(rawTexts, videoInfo, chunkIndex, totalChunks);

  const aiResponse = await generateAIResponse(prompt, {
    model: 'grok-4-1-fast-non-reasoning',
    zodSchema: aiResponseSchema,
    schemaName: 'EnhancedTranscript',
    temperature: 0.2,
    maxOutputTokens: 131072, // Reduced for smaller chunks
  });

  // Log response for debugging
  console.log(`[Enhance] Chunk ${chunkIndex + 1}/${totalChunks} response length: ${aiResponse.length}`);

  const parsed = safeJsonParse<unknown>(aiResponse);
  const validation = aiResponseSchema.safeParse(parsed);

  if (!validation.success) {
    console.error(`[Enhance] Chunk ${chunkIndex + 1} schema validation failed:`, validation.error.flatten());
    throw new Error(`Chunk ${chunkIndex + 1} schema validation failed`);
  }

  if (validation.data.enhancedSegments.length !== rawTexts.length) {
    console.error(
      `[Enhance] Chunk ${chunkIndex + 1} length mismatch: expected ${rawTexts.length}, got ${validation.data.enhancedSegments.length}`
    );
    throw new Error(`Chunk ${chunkIndex + 1} length mismatch`);
  }

  return validation.data.enhancedSegments;
}

/**
 * Process a chunk with retry logic and fallback to original text
 */
async function processChunkWithRetry(
  rawTexts: string[],
  videoInfo: { title: string; author?: string | null; description?: string | null },
  chunkIndex: number,
  totalChunks: number,
  maxRetries = 2
): Promise<string[]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await processEnhanceChunk(rawTexts, videoInfo, chunkIndex, totalChunks);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[Enhance] Chunk ${chunkIndex + 1} attempt ${attempt}/${maxRetries} failed:`, errorMessage);

      if (attempt < maxRetries) {
        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  // All retries failed - return original text as fallback
  console.error(`[Enhance] Chunk ${chunkIndex + 1} failed after ${maxRetries} attempts, using original text`);
  return rawTexts;
}

async function handler(req: NextRequest) {
  try {
    const body = await req.json();

    // 1. Validate request body
    const result = enhanceTranscriptSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request data', details: result.error.format() },
        { status: 400 }
      );
    }

    const { videoId, videoInfo, transcript } = result.data;
    const supabase = await createClient();

    // 2. Get user info
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 3. Check credits (using canGenerateVideo to mimic standard checks,
    // but we force a credit consumption regardless of cache since this is a new "action")
    // Wait, if we use canGenerateVideo with youtubeId, it might say "CACHED" and free.
    // But "Enhance" is a new paid action.
    // So we should check if they have remaining credits directly, ignoring the cache status of the video itself.
    // Or we can pass skipCacheCheck: true
    const decision = await canGenerateVideo(user.id, videoId, {
      client: supabase,
      skipCacheCheck: true
    });

    if (!decision.allowed) {
        return NextResponse.json(
            { error: decision.reason || 'Insufficient credits' },
            { status: 403 }
        );
    }

    // 4. Process transcript with AI (chunked for large transcripts)
    const rawTexts = transcript.map(s => s.text);
    let enhancedTexts: string[] = [];

    console.log(`[Enhance] Total segments: ${rawTexts.length}`);

    if (rawTexts.length <= SMALL_TRANSCRIPT_THRESHOLD) {
      // Small transcript: process in single request
      console.log(`[Enhance] Small transcript, processing in single request`);
      enhancedTexts = await processChunkWithRetry(rawTexts, videoInfo, 0, 1);
    } else {
      // Large transcript: process chunks in PARALLEL for speed
      const chunks = chunkArray(rawTexts, CHUNK_SIZE);
      console.log(`[Enhance] Large transcript, processing ${chunks.length} chunks in parallel`);

      const chunkPromises = chunks.map((chunk, i) => {
        console.log(`[Enhance] Starting chunk ${i + 1}/${chunks.length} (${chunk.length} segments)`);
        return processChunkWithRetry(chunk, videoInfo, i, chunks.length);
      });

      const results = await Promise.all(chunkPromises);
      enhancedTexts = results.flat();
    }

    // Final validation
    if (enhancedTexts.length !== transcript.length) {
      console.error(`[Enhance] Final segment count mismatch: Input ${transcript.length}, Output ${enhancedTexts.length}`);
      return NextResponse.json(
        { error: 'AI generated transcript length mismatch' },
        { status: 502 }
      );
    }

    console.log(`[Enhance] Successfully enhanced all ${enhancedTexts.length} segments`);

    // 7. Reconstruct Transcript
    const enhancedTranscript = transcript.map((segment, idx) => ({
        ...segment,
        text: enhancedTexts[idx]
    }));

    // 8. Consume Credit Atomic
    // We need to fetch stats again for the snapshot required by consumeVideoCreditAtomic
    // (Or rely on the ones from decision if they are fresh enough, but safer to re-fetch or use decision.stats if available)
    if (!decision.subscription || !decision.stats) {
         return NextResponse.json(
            { error: 'Failed to retrieve subscription info' },
            { status: 500 }
        );
    }

    const consumption = await consumeVideoCreditAtomic({
        userId: user.id,
        youtubeId: videoId,
        subscription: decision.subscription,
        statsSnapshot: decision.stats,
        counted: true,
        identifier: `enhance:${videoId}:${Date.now()}`,
        client: supabase
    });

    if (!consumption.success) {
        return NextResponse.json(
            { error: consumption.reason || 'Failed to consume credit' },
            { status: 500 }
        );
    }

    // 9. Update Database
    const { error: updateError } = await supabase
        .from('video_analyses')
        .update({ transcript: enhancedTranscript })
        .eq('youtube_id', videoId);

    if (updateError) {
        console.error('Failed to update transcript in DB:', updateError);
        // Note: Credit was already consumed. In a production system, we might want to rollback or flag this.
        // For now, we log it.
         return NextResponse.json(
            { error: 'Failed to save enhanced transcript' },
            { status: 500 }
        );
    }

    return NextResponse.json({
        success: true,
        transcript: enhancedTranscript
    });

  } catch (error) {
    console.error('Enhance transcript error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export const POST = withSecurity(handler, SECURITY_PRESETS.STRICT);
