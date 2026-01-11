/**
 * Utility functions for safely parsing JSON responses from AI models
 *
 * AI models sometimes return JSON wrapped in markdown code fences or with
 * extra whitespace/text. These utilities clean and extract the JSON payload.
 */

/**
 * Preprocesses AI responses to remove problematic characters that prevent JSON parsing.
 * Handles:
 * - BOM (Byte Order Mark) characters that shift position offsets
 * - Zero-width characters (U+200B, U+200C, U+200D)
 * - Control characters (except newlines/tabs)
 *
 * @param raw - Raw string response from AI model
 * @returns Cleaned string ready for JSON extraction
 *
 * @example
 * ```typescript
 * const response = "\uFEFF[{\"key\": \"value\"}]";
 * const cleaned = preprocessJsonResponse(response);
 * const parsed = JSON.parse(cleaned); // Works!
 * ```
 */
export function preprocessJsonResponse(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    return raw;
  }

  let cleaned = raw;

  // Remove BOM (Byte Order Mark) - common in UTF-8 responses
  cleaned = cleaned.replace(/^\uFEFF/, '');

  // Remove zero-width characters that break JSON parsing
  cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Remove control characters except newlines, carriage returns, and tabs
  // Preserves: \n (0x0A), \r (0x0D), \t (0x09)
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  // Trim leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Extracts JSON payload from AI model responses that may contain:
 * - Markdown code fences (```json ... ```)
 * - Extra whitespace or text before/after JSON
 * - Raw JSON arrays or objects
 *
 * @param raw - Raw string response from AI model
 * @returns Cleaned JSON string ready for parsing
 *
 * @example
 * ```typescript
 * const response = "```json\n{\"key\": \"value\"}\n```";
 * const cleaned = extractJsonPayload(response);
 * const parsed = JSON.parse(cleaned); // { key: "value" }
 * ```
 */
export function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }

  // If the string already starts with { or [, it's likely clean JSON - return as-is
  // This prevents incorrectly extracting inner arrays from objects like {"key":[...]}
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }

  // Try to extract content from markdown code fences like ```json ... ```
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  // Try to extract JSON object first (more common in structured AI responses)
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    return objectMatch[0];
  }

  // Try to extract JSON array
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    return arrayMatch[0];
  }

  return trimmed;
}

/**
 * Attempts to repair malformed JSON from AI model responses.
 * Handles common issues like:
 * - Unmatched brackets/braces (truncated JSON)
 * - Trailing commas before closing brackets
 * - Incomplete array elements
 *
 * @param raw - Raw string response that may contain malformed JSON
 * @returns Repaired JSON string ready for parsing
 *
 * @example
 * ```typescript
 * const malformed = '[{"title":"Test","quote":{"text":"Hello"';
 * const repaired = repairJson(malformed);
 * // Returns: '[{"title":"Test","quote":{"text":"Hello"}}]'
 * ```
 */
export function repairJson(raw: string): string {
  let cleaned = extractJsonPayload(raw);
  
  if (!cleaned) {
    return cleaned;
  }

  // Remove any trailing incomplete string (cut off mid-value)
  // Look for patterns like ,"text":"incomplete... at the end
  const incompleteStringMatch = cleaned.match(/,\s*"[^"]*"\s*:\s*"[^"]*$/);
  if (incompleteStringMatch) {
    // Find the last complete object/element
    const lastCompleteComma = cleaned.lastIndexOf(',', cleaned.length - incompleteStringMatch[0].length);
    if (lastCompleteComma > 0) {
      cleaned = cleaned.substring(0, lastCompleteComma);
    }
  }

  // Count brackets to check for balance
  const openBrackets = (cleaned.match(/\[/g) || []).length;
  const closeBrackets = (cleaned.match(/\]/g) || []).length;
  const openBraces = (cleaned.match(/\{/g) || []).length;
  const closeBraces = (cleaned.match(/\}/g) || []).length;

  // Add missing closing braces first (inner structures)
  for (let i = 0; i < openBraces - closeBraces; i++) {
    cleaned += '}';
  }
  
  // Then add missing closing brackets (outer array)
  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    cleaned += ']';
  }

  // Remove trailing commas before closing brackets/braces
  cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');

  // Handle case where there's a trailing comma at the very end
  cleaned = cleaned.replace(/,\s*$/, '');

  return cleaned;
}

/**
 * Safely parses JSON with automatic cleaning and repair of AI model responses.
 * First preprocesses to remove BOM/control chars, then tries to parse the cleaned JSON,
 * then attempts repair if parsing fails.
 *
 * @param raw - Raw string response that may contain JSON
 * @returns Parsed JSON object or throws if parsing fails
 * @throws {SyntaxError} If the cleaned string is not valid JSON even after repair
 *
 * @example
 * ```typescript
 * try {
 *   const data = safeJsonParse<MyType>("```json\n{\"key\": \"value\"}\n```");
 *   console.log(data.key); // "value"
 * } catch (error) {
 *   console.error('Failed to parse JSON:', error);
 * }
 * ```
 */
export function safeJsonParse<T = unknown>(raw: string): T {
  // Preprocess to remove BOM and control characters
  const preprocessed = preprocessJsonResponse(raw);
  const cleaned = extractJsonPayload(preprocessed);

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Try repair as fallback (using preprocessed input)
    const repaired = repairJson(preprocessed);
    return JSON.parse(repaired) as T;
  }
}
