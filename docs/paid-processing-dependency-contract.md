# Paid processing during dependency failures

## Dependency contract

### Cache lookup

`POST /api/check-video-cache` returns:

| Outcome | HTTP | Body |
| --- | --- | --- |
| Found | 200 | `{ status: "found", cached: true, ...existingFields }` |
| Genuinely absent | 200 | `{ status: "absent", cached: false, videoId }` |
| Dependency unavailable | 503 | Error contract below; **no `cached: false`** |

A found record can have missing generated fields. Missing summary/topics is not a database miss. `maybeSingle()` returning no row without an error establishes absence; quota, connection, permission, and cardinality errors do not. The client rejects malformed/unknown cache responses rather than starting generation. Public slug lookup errors render a retryable unavailable page instead of redirecting to analysis. Only successful absent lookups retain the existing fallback redirect.

### Unavailable response

```json
{
  "error": "Analysis is temporarily unavailable. Please try again later.",
  "code": "DEPENDENCY_UNAVAILABLE",
  "retryable": true
}
```

HTTP status: **503**. Header: `Cache-Control: no-store`.

`retryable` means the user may explicitly retry after recovery, not permission for an automatic retry loop. No credit/refund claim accompanies this error: an upstream call may already have happened. Actual limiter exhaustion remains **429**. Existing endpoint-specific authentication and credit-limit responses remain distinct.

Server code throws `DependencyUnavailableError` (from `lib/dependency-unavailable.ts`). Required dependency boundaries log a bounded dependency label and sanitized machine code, not database messages, credentials, or request bodies. Route-local catches must rethrow this error or return the unavailable response; they must not convert it into success, a cache miss, or an empty usage allowance.

### Paid admission

Every paid route opts into `withSecurity(..., { paidWork: true })` or `SECURITY_PRESETS.PAID`:

- transcript (including Supadata fallback)
- video-analysis, generate-topics, generate-summary, quick-preview
- suggested-questions, top-quotes, chat
- generate-image, notes/enhance, translate

Before entering a paid handler, middleware requires a successful cache-read readiness check, readable auth/guest/subscription usage dependencies, and a durable limiter admission. A failed read, malformed limiter reply, or failed admission write stops the handler. General free/read-only endpoint throttles remain best-effort; their own data dependencies still report errors.

This is dependency gating, **not** a new credit/reservation policy. Existing endpoint-specific allowance checks remain in place. It does not reserve customer credits across requests or introduce idempotency/reconciliation. Admission and caching changes must preserve this gate.

`video-analysis` stops on required save/credit-record failures. Theme generation follows successful persistence, so those failures do not launch another AI call. Cached analysis retrieval does not generate fresh themes. Failed persistence is not returned as a successful saved analysis.

### UI behavior

- Cache/preflight failure has an explicit **Try again** action; rerenders do not restart processing.
- Cached transcript/highlights can remain visible while paid work is blocked.
- Opening cached content does not re-fetch a potentially paid transcript for language discovery. Missing question suggestions use local fallback text.
- A paid 503 or failed post-generation update (including transport rejection) blocks further paid requests in the current analysis attempt. Chat/image requests share this guard; queued translation requests reject rather than silently completing with untranslated text.
- Retry begins a new attempt only on explicit user action. Already-issued upstream requests cannot be undone. Preview remains bounded and non-blocking; concurrent requests already admitted before a failure may complete.

## Limiter persistence and RLS

Migration: `supabase/migrations/20260923060000_server_only_limiter.sql`.

The migration removes all existing policies on this table, revokes direct PUBLIC/anon/authenticated table access, and restricts RPC execution to `service_role`. Two RPCs are exposed to trusted server code:

- `check_rate_limit_server(text, text, bigint, integer, boolean)`: serialized count + optional admission insert in one transaction; failed writes cannot return allowed.
- `guest_usage_server(text[], boolean)`: reads/persists one-time guest usage without a browser RLS-filtered query masquerading as empty history.

Their `SECURITY DEFINER` owner is `limiter_executor`: NOLOGIN, no superuser or BYPASSRLS privileges, table-scoped SELECT/INSERT/DELETE, pinned empty search path. Browser roles cannot execute these RPCs or the legacy cleanup function. `lib/limiter-store.ts` is server-only and uses the existing service client without attaching a browser session. Missing service credentials fail closed.

PostgreSQL 17 grants a non-superuser role creator ADMIN membership with SET and INHERIT disabled. Ownership transfer therefore temporarily enables SET and INHERIT for the migration executor, allowing both transfer and the subsequent function ACL changes. Both options are disabled again before commit; the target role's temporary schema CREATE grant is also revoked. The creator retains PostgreSQL's administrative membership, not runtime inheritance or SET access. All changes are transactional. Release preflight must still reject unexpected pre-existing target-role privileges or memberships.

Admission performs bounded retention of up to 100 ordinary `ratelimit:*` records older than 31 days, beyond the maximum supported 30-day window. Guest allowance records never expire through this cleanup. The legacy service-only cleanup function is also bounded and excludes guest records.

**Rollout prerequisite:** apply the migration through the approved deployment process and configure server-only `SUPABASE_SERVICE_ROLE_KEY`. Without either, fresh paid processing intentionally returns 503. This work does not apply production migrations or change production configuration.

## Local verification

No vendor calls or production database access are needed by these tests.

```bash
npm test
npx tsc --noEmit
npm run lint
```

`npm test` runs Vitest route/UI tests plus the pre-existing `tsx --test` suites. Route tests execute exported handlers with mocked database/vendor counters. UI tests mount the real analysis-page orchestrator with browser/player child widgets stubbed. Translation tests execute the actual batch queue. SQL tests separately verify real PostgreSQL permissions and transaction behavior.

Local database test (Docker running and `postgres:17` available):

```bash
npm run test:limiter-db
```

The runner creates a uniquely named disposable PostgreSQL container with no published ports, then removes it in `finally`. It does not accept a database URL or load environment files. A fresh cluster isolates roles as well as tables. Bootstrap uses the local superuser, but the migration connects as a NOSUPERUSER CREATEROLE/BYPASSRLS database/table/cleanup-function owner, with `public` owned by `pg_database_owner` and the target role absent.

A failure injected immediately before COMMIT must restore policies, table/schema/function ACLs, cleanup definition, rows and memberships, and remove newly created functions/role. Successful migration must leave narrow function ownership/search paths and no executor SET/INHERIT or target schema CREATE privilege. The suite also checks browser denial, server persistence, read/write failure, recovery, retention, and concurrency. Local permission tests do not establish production integration health.
