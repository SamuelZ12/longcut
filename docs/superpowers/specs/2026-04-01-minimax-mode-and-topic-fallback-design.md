# MiniMax Mode And Topic Fallback Design

## Status

Approved in conversation on 2026-04-01.

## Context

Phase 1 added MiniMax as a text provider, but two follow-up issues remain in the current product behavior:

1. The home-page and branded URL inputs still show the `smart` / `fast` selector when the client provider is MiniMax.
2. Some analyzed videos show generic highlight titles like `Part 1`, `Part 2`, and so on instead of actual AI-generated reel titles.

These issues are related but have different root causes.

### Root Cause 1: MiniMax Is Not Treated As A Forced-Smart Provider On The Client

The client currently special-cases Grok only:

- `components/url-input.tsx`
- `components/url-input-with-branding.tsx`
- `lib/hooks/use-mode-preference.ts`
- `lib/ai-providers/client-config.ts`

Those paths call `isGrokProviderOnClient()`, so MiniMax is treated like a selectable-mode provider even though the desired UX is to behave like Grok and force the smarter topic pipeline.

### Root Cause 2: Generic `Part N` Titles Come From Local Emergency Fallback Logic

The titles are not coming from MiniMax or any other provider. They are synthesized locally in `buildFallbackTopics()` inside `lib/ai-processing.ts`.

When topic generation produces no usable provider-backed topics, `generateTopicsFromTranscript()` eventually falls through to:

- `buildFallbackTopics()`
- `title: \`Part ${i + 1}\``

In live verification this happened after MiniMax topic generation failed. The registry already supports retryable per-call provider fallback, but the topic pipeline can still end up with no valid topics and then emit the generic local fallback reels.

## Goals

- Hide the `smart` / `fast` selector for MiniMax the same way the UI already does for Grok.
- Force MiniMax to use the smart topic-generation UX on the client.
- Prefer real provider-backed topic generation over synthetic `Part N` fallback reels.
- Prevent obviously placeholder reel titles from reaching users when a provider-backed topic pass should still be attempted.
- Keep the existing provider abstraction and make the smallest correct change.

## Non-Goals

- Redesigning the entire topic-generation pipeline.
- Removing all fallback behavior from the application.
- Changing image generation behavior.
- Reworking provider adapters outside what is needed for topic fallback selection.

## Decision Summary

This follow-up will do two things:

1. Promote MiniMax into the same client-side forced-smart UX bucket as Grok.
2. Add topic-pipeline-level provider fallback before `buildFallbackTopics()` is allowed to synthesize generic chunk titles.

The local synthetic fallback remains as a last resort only after provider-backed topic generation has been exhausted.

## Proposed Design

### 1. Replace Grok-Only Client Behavior With Provider Capabilities

The current client helper name and behavior are too specific:

- `isGrokProviderOnClient()`

The client should replace that helper with `shouldForceSmartModeOnClient()`, which answers the actual UI question directly.

Initial behavior:

- Grok: `true`
- MiniMax: `true`
- Gemini: `false`

Affected files:

- `lib/ai-providers/client-config.ts`
- `components/url-input.tsx`
- `components/url-input-with-branding.tsx`
- `lib/hooks/use-mode-preference.ts`

This keeps the UI rule aligned with provider behavior instead of model brand names.

### 2. Introduce Topic-Pipeline-Level Provider Retry Before Local Reel Fallback

`generateTopicsFromTranscript()` already benefits from per-call retryable fallback inside the registry, but that is not enough to guarantee that a complete topic-generation run succeeds.

Current problem:

- a provider-backed step can fail or produce no usable topics
- chunk reduction can still collapse to zero candidates
- the overall pipeline then drops into `buildFallbackTopics()`
- users see `Part 1`, `Part 2`, etc.

The fix is to add one higher-level provider retry boundary around topic generation itself.

Behavior:

1. Run topic generation with the resolved primary provider.
2. If the overall provider-backed result is empty, invalid, or clearly degraded, and another configured provider exists, retry the topic-generation pipeline once with that provider forced explicitly.
3. Only if both provider-backed attempts fail should the code fall through to local synthetic fallback.

This is intentionally a single-hop retry, consistent with the existing provider strategy.

### 3. Define What Counts As A Provider-Backed Topic Failure

The provider retry should be triggered by pipeline-level failure conditions, not just thrown transport errors.

Initial retry conditions:

- single-pass generation throws or returns no valid topics
- chunked candidate generation and reduction produce zero usable topics
- the final single-pass recovery attempt also produces zero usable topics

The goal is simple: if the AI topic pipeline produced no real topics, give another provider a full chance before synthesizing local reels.

### 4. Keep `buildFallbackTopics()` As A Last Resort Only

`buildFallbackTopics()` remains in the system because it still has value as a final resilience mechanism.

But after this change it should only run when:

- the primary provider path failed to produce usable topics, and
- the configured alternate provider path also failed to produce usable topics

This sharply reduces how often users will ever see generic chunk titles.

### 5. Improve Local Fallback Titles If They Ever Appear

Even after provider retry, the remaining last-resort titles should be less placeholder-like than `Part 1`, `Part 2`.

If local fallback is reached, use deterministic timestamp-based labels in the format:

- `Highlights from 00:00-04:30`

The main purpose is to avoid exposing obviously unfinished-looking labels while keeping the fallback implementation predictable.

### 6. Keep Logging Clear About Which Path Won

Add or preserve logs that distinguish:

- primary provider success
- pipeline-level fallback to alternate provider
- final local synthetic fallback

This is important because the prior issue was easy to misread as “MiniMax generated bad titles” when the bad titles actually came from local fallback code.

## Data Flow After Change

For MiniMax on the client:

1. `client-config.ts` resolves the client provider
2. provider behavior marks MiniMax as forced smart mode
3. the URL input components hide the selector
4. `useModePreference()` defaults to and enforces `smart`

For topic generation:

1. resolve primary provider
2. run the normal topic-generation pipeline
3. if no usable provider-backed topics survive, resolve one alternate configured provider
4. rerun topic generation once with that forced provider
5. only then, if still empty, use local fallback topics

## Error Handling

- Do not swallow the distinction between provider-backed failure and local fallback.
- Pipeline-level retry should not recurse indefinitely.
- If a theme-specific request yields no provider-backed topics, preserve the current rule of avoiding unrelated generic themed fallbacks.
- If only one provider is configured, behavior stays the same except that local fallback titles become less placeholder-like.

## Testing And Verification

Required verification:

1. Client config tests proving MiniMax now forces smart mode on the client.
2. Component or hook-level verification that the mode selector is hidden for MiniMax.
3. Topic-generation tests proving a provider-backed retry occurs before local fallback topics are emitted.
4. Topic-generation tests proving local fallback titles are no longer `Part N` if fallback is reached.
5. Existing provider tests continue to pass.

Manual verification:

- Set `AI_PROVIDER=minimax` and `NEXT_PUBLIC_AI_PROVIDER=minimax`
- confirm the home-page and branded inputs no longer show the mode selector
- simulate or reproduce a primary-provider topic failure with another configured provider available
- confirm the second provider is attempted before local fallback reels are returned
- confirm any remaining local fallback titles are no longer `Part 1`, `Part 2`

## Risks

- Topic-generation retry at the pipeline level could increase latency on provider failures. This is acceptable because it only happens after a failed topic pass.
- If the alternate provider is also unavailable, the system still needs a last-resort fallback path.
- The change should avoid broad refactors in `lib/ai-processing.ts`; keep new control flow as small and explicit as possible.
