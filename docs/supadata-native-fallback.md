# Native-only transcript fallback

## Contract and cost boundary

Verified against [Supadata transcript documentation](https://docs.supadata.ai/get-transcript)
and [error reference](https://docs.supadata.ai/errors) on **2026-09-24**:

- `GET /v1/transcript`, `mode=native`, `text=false`. Omitted mode defaults to `auto`, which can purchase generated transcription. Only canonical YouTube URLs are sent by this route; file URLs would force generation regardless of mode.
- Timestamped `content` entries use **milliseconds** for both `offset` and `duration`, including offsets below 500. Longcut converts these to seconds without magnitude heuristics.
- Native extraction costs 1 credit. HTTP **206** means transcript unavailable and still costs 1 credit; it is not a usable partial transcript.
- `x-billable-requests` reports **credits**, not request count. Missing/invalid headers mean unknown, never inferred zero. An explicit `0` is preserved.
- HTTP **202** can accept background work. Its billing header is a **precharge estimate**, reconciled in the vendor dashboard after completion. Polling headers report zero and cannot establish final job cost.
- Empty `content: []` is not usable. Vendor documentation notes that empty generated results can still be charged. Neither empty results nor errors establish zero vendor cost.

`lib/supadata-transcript-provider.ts` makes at most **one** upstream call per invocation.
No language retries, redirect following, job polling, or automatic resubmission. Supadata can return another available language without another request.
Its 20-second deadline covers fetching headers and reading/parsing the body. Request cancellation aborts local waiting too; an already-aborted invocation sends nothing.
**Local abort or timeout does not guarantee that vendor work or charges stopped.** Transport errors also leave upstream acceptance unknown.
This bounds the Supadata attempt, not the existing YouTube-direct strategy or entire analysis flow.

## Outcomes and handoff for cache/admission callers

The adapter returns a discriminated `SupadataTranscriptResult` with safe `metadata` on every outcome.
Only `success` carries usable `segments`. Failures are not thrown as caption absence.

| Outcome | Conditions | `/api/transcript` status | Cache guidance |
| --- | --- | --- | --- |
| `success` | HTTP 200, validated non-empty timestamped content | 200 | Eligible for native success cache |
| `unavailable` | HTTP 206 or HTTP 200 empty content array | 404 | Candidate for short native negative cache |
| `dependency_failure` | Other upstream HTTP status, malformed body/segment, unconfigured fallback, cancellation before dispatch | 502 | Do not negative-cache as missing captions |
| `unknown_upstream_acceptance` | HTTP 202/job-shaped body, timeout, in-flight cancellation, transport error | 502; timeout 504 | Never treat as missing captions; no automatic resubmission |

Error responses include `outcome`, a stable `TRANSCRIPT_*` code, and (for adapter failures) `reason`, `source: "supadata"`, `retryable: false`.
Live success responses include `outcome: "success"` and `source` (`youtube-direct` or `supadata`).
Route-generated UUID `requestId` is returned in body and `x-request-id`, propagated to the adapter and upstream header.
Raw job IDs, billing details, and vendor response bodies are not exposed in the API. Unexpected job IDs are hashed for log correlation, not retained for polling.

`supadataNativeCacheIdentity(videoId, requestedLang?)` publishes the future cache namespace:

```text
["supadata","native","v1","abcdefghijk","en"]
["supadata","native","v1","abcdefghijk",null]
```

Use the requested language preference, not the returned language. Missing/empty preference maps to `null`.
Do not reuse entries from `auto`/generated requests in this namespace. This ticket publishes identity/outcomes; it does not implement shared caching or cross-request deduplication.

`noCreditsUsed` remains a compatibility flag scoped to **Longcut video allowance**, made explicit with `creditsScope: "longcut_allowance"` on transcript errors.
The shared UI/API message states that this does not indicate whether the provider charged Longcut. Rate-limit admission requests may still be counted.

## Safe telemetry

Questions answered: How many vendor attempts start? Which outcomes and upstream statuses occur? How much reported credit usage is known versus estimated/unknown? How long do attempts take?

Two JSON events are emitted per dispatched attempt:

- `supadata_transcript_started`: `source`, `mode`, `requestId`.
- `supadata_transcript_completed`: those fields plus `upstreamStatus` (nullable), `billableCredits` (nullable), `billingKind` (`reported`, `precharge_estimate`, `unknown`), `latencyMs`, `outcome`, `reason`, `jobIdHash` (nullable SHA-256).

No API keys, cookies, raw exceptions, full URLs, user IDs, or transcript bodies are logged by the adapter. Started events without completed counterparts identify interrupted processes/log gaps; their billing is unknown. A pre-dispatch cancellation emits neither event because no vendor call was attempted.

## Verification after a future approved release

No live paid API calls are needed for local verification. After an approved release, use ordinary production traffic:

1. Choose a fixed UTC window and deployment version. Export these two JSON event types from application logs; use `requestId` to deduplicate repeated log delivery. Count distinct **started** request IDs as attempted calls, and separately count completed/missing completions. Started calls may fail before reaching the vendor.
2. Group completions by `mode`, `upstreamStatus`, `outcome`, and `reason`. All modes must be `native`; investigate any unexpected jobs. Compare attempt volume against the same-length baseline, normalized by analysis traffic.
3. Sum `billableCredits` only where `billingKind == "reported"`. Separately report the sum of `precharge_estimate` values, count of `unknown` billing events, and unmatched starts. Include failed/unavailable requests in credit totals. Do not replace nulls with zero, multiply request counts by one, or present known totals as complete billing.
4. Compare vendor dashboard request history and credit totals for the same UTC window (and key/project where available). Reconcile 202 estimates against final dashboard charges. Account for other clients, late responses, logging gaps, and window boundaries; identical request counts need not mean identical credits.
5. Derive latency p50/p95/p99 from `latencyMs`, failure rates from outcomes, and attempted-call rate from starts. Keep request IDs in logs, not metric labels. Investigate credit divergence, unknown billing growth, or unmatched starts before judging cost reduction.

## Executable local checks

```bash
./node_modules/.bin/vitest run tests/supadata-transcript.test.ts tests/transcript-fallback.test.ts
./node_modules/.bin/tsc --noEmit
npm test
npm run lint
```

Contract fixtures mock every Supadata request, assert native mode and exact call counts, cover billable failure/206/202/malformed/timeout/cancellation paths, and test millisecond offsets of 120 and 8150 explicitly. Route tests isolate admission middleware; the existing `tests/paid-processing.test.ts` suite separately covers admission failures before paid calls.
