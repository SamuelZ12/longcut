# Vakitek native-caption fallback

Verified against the [Vakitek transcript API](https://api.vakitek.co.uk) on **2026-10-13**.

Tried after YouTube direct and before Supadata when `VAKITEK_API_KEY` is set: `GET /v1/youtube/transcript?video=<id>&format=json[&target_language=<lang>]`,
header `X-API-Key`. Captions only; it never generates/transcribes audio, the same "native" semantics as Supadata's `mode=native`.

HTTP 200 carries one `data[]` item per request, either a success item (`transcript` entries with `start`/`dur` already in **seconds**) or an
error item (`error` code, still HTTP 200). `billing.events.transcript` is the exact billed count (0 or 1): billed only when a transcript is
returned, at $2 per 1,000 transcripts; error items are free. There are no async jobs, no 202, and no job polling, one request per video.

`lib/vakitek-transcript-provider.ts` makes at most **one** upstream call with the same 20-second deadline, abort handling, and discriminated
`VakitekTranscriptResult` outcomes (`success` / `unavailable` / `dependency_failure` / `unknown_upstream_acceptance`) as the Supadata adapter.
`NO_CAPTIONS`/`LANGUAGE_NOT_AVAILABLE`/`NOT_FOUND`/`PRIVATE`/`MEMBERS_ONLY`/`AGE_RESTRICTED` map to `unavailable`; `BLOCKED`/`RATE_LIMITED`/`UPSTREAM_ERROR`,
non-200 HTTP, and malformed bodies map to `dependency_failure`; timeouts and transport errors map to `unknown_upstream_acceptance`. The API key is
never logged.

`/api/transcript` reuses Supadata's spend admission/reservation/transition and cache-owner calls unchanged for the Vakitek attempt, same cache/spend
identity, since that key already represents one native-transcript slot per video/language regardless of which paid vendor serves it. A Vakitek
`unavailable` result is a confirmed caption absence, so the route does not call Supadata afterward for the same video (avoiding a second charge for
captions that don't exist). Only a `dependency_failure` result falls through to Supadata; that fall-through spends two reservation units in
`transcript_spend_attempts`, one per vendor attempt, each against its own dispatch/complete transition. An `unknown_upstream_acceptance` result does
**not** fall through: the `uncertain` transition already set `blocked_until` ten minutes out on that same request_key, so a Supadata reservation
right after would always observe `cooldown` and 429 the caller instead of actually retrying. The route instead returns the same response Supadata's
own adapter produces for its `unknown_upstream_acceptance` outcome (shared `vendorFailureResponse` helper in `app/api/transcript/route.ts`). Deployments
without `VAKITEK_API_KEY` set are unaffected: the attempt is skipped entirely and existing YouTube-direct/Supadata behavior is unchanged.

See [`supadata-native-fallback.md`](./supadata-native-fallback.md) for the shared outcome table, telemetry shape, and verification steps, which apply
identically with `source: "vakitek"`.
