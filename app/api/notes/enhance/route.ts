import { NextRequest, NextResponse } from "next/server";
import { withSecurity } from "@/lib/security-middleware";
import { generateAIResponse } from "@/lib/ai-client";
import { z } from "zod";

const enhancePayloadSchema = z.object({
  quote: z
    .string()
    .min(1, "Quote is required")
    .max(2000, "Quote must be under 2,000 characters"),
});

const FILLER_WORDS = [
  "uh",
  "um",
  "er",
  "ah",
  "you know",
  "i mean",
  "like",
  "kinda",
  "kind of",
  "sort of",
  "you see",
  "right",
  "okay",
  "ok",
  "yeah",
  "so yeah",
  "mmm",
  "hmm",
  "y'know",
];

const fillerPattern = new RegExp(
  `\\b(?:${FILLER_WORDS.map((word) => word.replace(/\s+/g, "\\s+")).join("|")})\\b`,
  "gi"
);

function wrapInCdata(text: string): string {
  return `<![CDATA[${text.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function tidyWhitespace(text: string): string {
  return text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/["“”]+$/g, "")
    .replace(/^["“”]+/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\r\n]{2,}/g, " ")
    .trim();
}

function fallbackClean(text: string): string {
  const cleaned = text
    .split(/\n+/)
    .map((line) =>
      line
        .replace(fillerPattern, "")
        .replace(/[\s\u00A0]+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join("\n");

  return cleaned.length > 0 ? cleaned : text.trim();
}

async function handler(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = enhancePayloadSchema.safeParse(body);

  if (!parsed.success) {
    console.error('[Enhance API] Validation failed:', parsed.error.issues);
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid request" },
      { status: 400 }
    );
  }

  const quote = parsed.data.quote.trim();

  if (!quote) {
    return NextResponse.json(
      { error: "Quote is required" },
      { status: 400 }
    );
  }

  console.log('[Enhance API] Processing quote:', quote.substring(0, 50) + '...');

  const prompt = `<task>
<role>You are a meticulous transcript editor tasked with polishing noisy speech.</role>
<goal>Rewrite the snippet so it reads like clean prose while preserving meaning.</goal>
<instructions>
  <item>Keep the speaker's intent and tense the same.</item>
  <item>Remove filler words (uh, um, like, you know, I mean, etc.).</item>
  <item>Fix obvious transcription mistakes and punctuation.</item>
  <item>Break into short sentences if needed, but avoid adding new ideas.</item>
  <item>Return plain text only—no quotes, bullets, markdown, or commentary.</item>
</instructions>
<transcript>${wrapInCdata(quote)}</transcript>
</task>`;

  let cleanedText: string | null = null;

  try {
    const response = await generateAIResponse(prompt, {
      temperature: 0.2,
      topP: 0.8,
      maxOutputTokens: 512,
      timeoutMs: 15000,
    });

    if (response) {
      cleanedText = tidyWhitespace(response);
    }
  } catch (error) {
    console.error("AI enhancement failed:", error);
    cleanedText = null;
  }

  if (!cleanedText) {
    cleanedText = fallbackClean(quote);
  }

  return NextResponse.json({ cleanedText });
}

export const POST = withSecurity(handler, {
  requireAuth: false, // Allow anonymous users to enhance notes
  rateLimit: {
    windowMs: 60 * 1000,
    maxRequests: 30,
  },
  maxBodySize: 32 * 1024,
  allowedMethods: ["POST"],
  csrfProtection: false, // Disable CSRF for anonymous requests
});
