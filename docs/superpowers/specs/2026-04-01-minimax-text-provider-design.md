# MiniMax Text Provider Phase 1 Design

## Status

Approved in conversation on 2026-04-01.

## Context

The application already routes most AI text generation through a small internal provider layer:

- `lib/ai-client.ts`
- `lib/ai-providers/types.ts`
- `lib/ai-providers/registry.ts`

Today that layer supports Grok and Gemini. The user wants to add `MiniMax-M2.7` as a new provider, use it for text workflows first, and avoid a larger platform refactor to Vercel AI SDK or a separate FastAPI service.

This codebase also has one important exception: `app/api/generate-image/route.ts` is Gemini-specific and should remain unchanged in phase 1.

## Goals

- Add MiniMax as a third provider for text generation.
- Allow `AI_PROVIDER=minimax` without changing route contracts.
- Keep Gemini image generation untouched.
- Preserve existing Grok/Gemini paths as fallbacks during rollout.
- Keep the implementation small and aligned with the current Next.js server-route architecture.

## Non-Goals

- Adopting Vercel AI SDK in phase 1.
- Introducing a FastAPI or any separate Python service.
- Rewriting prompts, response contracts, or client UI behavior.
- Migrating image generation away from Gemini.
- Removing Grok or Gemini support.

## Current Integration Points

Text generation is already centralized through `generateAIResponse()` / `generateAIResult()`, which means phase 1 can stay mostly inside the provider layer.

Affected text flows include:

- topic generation and theme generation in `lib/ai-processing.ts`
- `app/api/generate-summary/route.ts`
- `app/api/chat/route.ts`
- `app/api/quick-preview/route.ts`
- `app/api/suggested-questions/route.ts`
- `app/api/top-quotes/route.ts`
- `app/api/notes/enhance/route.ts`
- translation in `lib/translation/llm-translate-client.ts`

Known provider-specific hotspots that must be updated:

- `lib/ai-providers/registry.ts` hard-codes `'grok' | 'gemini'`
- `lib/ai-providers/client-config.ts` hard-codes the same client provider union
- `scripts/validate-env.ts` only validates `XAI_API_KEY` and `GEMINI_API_KEY`
- `lib/ai-processing.ts` contains `providerKey === 'grok'` logic
- `app/privacy/page.tsx` references Gemini as the text model provider

## Decision Summary

Phase 1 will add a dedicated MiniMax adapter to the existing internal provider layer. It will not introduce Vercel AI SDK or FastAPI. MiniMax will be used for text routes only, while image generation remains on Gemini.

## Proposed Design

### 1. Add a Dedicated MiniMax Adapter

Create `lib/ai-providers/minimax-adapter.ts` implementing the existing `ProviderAdapter` interface.

Implementation choices:

- Use MiniMax's OpenAI-compatible HTTP endpoint via `fetch`
- Default base URL: `https://api.minimax.io/v1`
- Default model: `MiniMax-M2.7`
- Support `MiniMax-M2.7-highspeed` through `AI_DEFAULT_MODEL` overrides
- Normalize response text, usage metadata, timeout errors, and retryable provider errors inside the adapter

The adapter should remain a server-only implementation, matching the current Grok adapter pattern.

### 2. Treat Structured Output as Best-Effort, Not Assumed

This application depends heavily on structured JSON responses for topics, summaries, chat, and translation. MiniMax compatibility is the main migration risk.

Phase 1 behavior:

- Continue sending strong prompt-level JSON instructions exactly as the app does today
- Accept `zodSchema` in the provider contract so calling code stays unchanged
- Do not rely on provider-native schema transport or `response_format` enforcement for MiniMax in phase 1
- Return plain text from the adapter and rely on the existing parsing and recovery logic already present in routes like chat and summary

This keeps the adapter compatible with the current call sites without forcing a large prompt or route rewrite, and it removes uncertainty around MiniMax schema-transport support from the first rollout.

### 3. Handle Reasoning Output Defensively

MiniMax compatibility docs indicate reasoning content may be surfaced separately or embedded in output depending on endpoint behavior.

Phase 1 behavior:

- Prefer request settings that separate reasoning from final answer when supported
- Normalize the adapter result so downstream code receives final user-facing text only
- Strip any stray reasoning wrappers or `<think>`-style content from the returned text before downstream JSON parsing

This rule exists to protect strict JSON consumers in the current routes.

### 4. Extend Registry and Environment Plumbing

Update these files:

- `lib/ai-providers/registry.ts`
- `lib/ai-providers/client-config.ts`
- `scripts/validate-env.ts`
- `README.md`

New environment variables:

- `MINIMAX_API_KEY`
- `MINIMAX_API_BASE_URL` with default `https://api.minimax.io/v1`

Configuration behavior:

- `AI_PROVIDER=minimax` selects MiniMax as the primary text provider
- `AI_DEFAULT_MODEL` can override the default MiniMax model
- existing provider keys can remain configured for fallback behavior

### 5. Replace Brand Checks with Provider Behavior Metadata

`lib/ai-processing.ts` currently contains logic keyed directly off `providerKey === 'grok'`.

Phase 1 should replace this with a small provider-behavior lookup owned by the provider layer, for example:

- `forceFullTranscriptTopicGeneration`

Initial behavior should stay conservative:

- Grok: `true`
- Gemini: `false`
- MiniMax: `false`

This preserves known behavior while removing hard-coded brand logic from processing code.

### 6. Keep Fallbacks Simple and Deterministic

Phase 1 should preserve the current single-hop fallback model rather than introducing multi-provider routing complexity.

Behavior:

- primary provider comes from `AI_PROVIDER`
- if the primary provider fails with a retryable error, the registry tries one alternate configured provider
- for `AI_PROVIDER=minimax`, the fallback remains deterministic based on registry order and available keys

This keeps rollout safe without turning phase 1 into a provider-orchestration project.

### 7. Leave Image Generation Alone

`app/api/generate-image/route.ts` remains Gemini-specific in phase 1.

Reason:

- image generation is a separate capability with its own API assumptions and model naming
- changing it would expand the rollout surface without helping the MiniMax text migration

## Data Flow

For text routes after phase 1:

1. A route or library helper calls `generateAIResponse()` or `generateAIResult()`
2. `lib/ai-client.ts` converts request options into provider-generic params
3. `lib/ai-providers/registry.ts` resolves `AI_PROVIDER=minimax`
4. `minimax-adapter.ts` issues the HTTP request, normalizes the response, and returns `{ content, usage, provider, model }`
5. Existing route logic parses the returned text exactly as it does today
6. If MiniMax fails with a retryable error, registry-level fallback uses a configured alternate provider

For image generation, the flow remains unchanged and continues to use Gemini directly.

## Error Handling

MiniMax adapter error handling should match the existing provider style:

- classify authentication, bad request, timeout, rate limit, and 5xx/service errors
- mark only retryable provider failures as eligible for registry fallback
- preserve existing user-facing route responses instead of inventing new UI error strings
- log normalized adapter diagnostics with a `[MiniMax]` prefix

Examples of expected retryable categories:

- request timeout
- rate limit / quota exhaustion when a fallback provider can still succeed
- transient 5xx service failures

Examples of non-retryable categories:

- invalid API key
- malformed request payload
- unsupported model name

## Testing And Verification

Phase 1 verification should focus on route compatibility, not broad architecture changes.

Required verification:

1. `npm run lint`
2. Topic generation flow through the analysis page
3. Summary generation
4. Chat generation and JSON parsing
5. Translation flow
6. `quick-preview`, `suggested-questions`, `top-quotes`, and `notes/enhance`
7. Existing Gemini image generation still works unchanged

Success criteria:

- no request or response contract changes
- `modelUsed` continues to be populated
- JSON parsing and recovery paths continue to work
- fallback provider behavior still works on retryable failures
- image generation remains unaffected

## Rollout Plan

1. Add MiniMax adapter and provider plumbing behind the existing abstraction
2. Deploy with `MINIMAX_API_KEY` configured and existing provider keys left in place
3. Run MiniMax as primary for text in preview or another low-risk environment first
4. Monitor parse failures, empty responses, timeout frequency, and fallback frequency
5. If MiniMax quality or reliability is worse than expected, switch `AI_PROVIDER` back without code changes

## Follow-Up Work After Phase 1

Possible later work, explicitly out of scope for this spec:

- adopt Vercel AI SDK behind `lib/ai-client.ts` if the team wants more standardization later
- revisit whether MiniMax should use full-transcript topic generation like Grok
- move image generation off Gemini if a separate image-provider decision is made
- add richer provider capabilities if future models need more nuanced routing
