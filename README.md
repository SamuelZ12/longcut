# Little universe

Little universe turns long-form YouTube videos into a structured learning workspace. Paste a URL and the app generates highlight reels, timestamped AI answers, and a place to capture your own notes so you can absorb an hour-long video in minutes.

## Overview

The project is a Next.js 15 + React 19 application that wraps xAI’s Grok 4 Fast models (with optional Gemini adapters) and Supadata transcripts with a polished UX. Supabase provides authentication, persistence, rate limiting, and profile preferences. The experience is optimized for fast iteration using Turbopack, Tailwind CSS v4, and shadcn/ui components.

## Feature Highlights

- AI highlight reels with Smart (quality) and Fast (speed) generation modes, Play All playback, and theme-based re-generation.
- AI-powered quick preview, structured summary, suggested questions, and memorable quotes surfaced in parallel.
- AI chat grounded in the transcript with structured JSON responses, timestamp citations, and fallbacks when the provider rate-limits.
- Transcript viewer that stays in sync with the YouTube player; click any sentence to jump or capture the quote.
- Personal notes workspace with transcript, chat, and takeaway sources plus an `/all-notes` dashboard for cross-video review.
- Authenticated library pages for saved analyses, favorites, generation limits, and Supabase-backed profile preferences.
- Aggressive caching of previous analyses, background refresh tasks, and rate limits for anonymous vs. signed-in users.
- Security middleware that enforces CSP headers, CSRF protection, body-size caps, and Supabase-backed rate limiting.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=SamuelZ12/tldw&type=date&legend=top-left)](https://www.star-history.com/#SamuelZ12/tldw&type=date&legend=top-left)

## Architecture

- Frontend stack: Next.js 15 App Router, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, lucide-react, sonner toasts.
- Backend runtime: Next.js serverless route handlers with `withSecurity` middleware for CSRF, input validation (Zod), and rate caps.
- AI pipeline: `lib/ai-processing.ts` and `lib/ai-client.ts` orchestrate provider-agnostic prompts, structured output schemas, fallback handling, and transcript chunking via `lib/ai-providers/`.
- Transcript & metadata: Supadata API delivers transcripts; lightweight YouTube oEmbed calls pull thumbnails and titles.
- Persistence: Supabase stores `video_analyses`, `user_videos` (history + favorites), `user_notes`, `profiles` (topic generation mode, profile data), and `rate_limits`.
- Authentication: Supabase Auth with session refresh in `middleware.ts`; `AuthModal` drives sign-up prompts when limits are hit.
- Security: Global middleware adds CSP/HSTS headers, CSRF tokens for stateful requests, hashed IP identifiers for anonymous rate limiting, and request body size guards.

## Application Pages

- `/` – Landing page with branded URL input, mode selector, and auth modal triggers when rate limits are reached.
- `/analyze/[videoId]` – Primary workspace: YouTube player, highlight reels, theme selector, summary/chat/transcript/notes tabs, suggestions, and note-saving flows.
- `/my-videos` – Auth-required library of previously analyzed videos with search, favorites, and quick resume.
- `/all-notes` – Auth-required notebook that aggregates notes across videos with filtering, sorting, markdown rendering, and deletion.
- `/settings` – Profile screen for updating name, password, viewing usage stats, and persisting preferred topic generation mode.

## API Surface

- Video ingestion: `/api/video-info`, `/api/transcript`, `/api/check-video-cache`, `/api/video-analysis`, `/api/save-analysis`, `/api/update-video-analysis`, `/api/link-video`.
- AI generation: `/api/generate-topics`, `/api/generate-summary`, `/api/quick-preview`, `/api/suggested-questions`, `/api/top-quotes`.
- Conversational tools: `/api/chat` (provider-agnostic chat with citations) and `/api/check-limit` for pre-flight rate checks.
- User data: `/api/notes`, `/api/notes/all`, `/api/toggle-favorite`.
- Security utilities: `/api/csrf-token` and the shared `withSecurity` middleware (allowed methods, rate limits, CSRF validation).

## Directory Layout

```
.
├── app/
│   ├── api/                    # Route handlers for AI, caching, notes, auth, etc.
│   ├── analyze/[videoId]/      # Client page for the analysis workspace
│   ├── all-notes/              # Notes dashboard (client component)
│   ├── my-videos/              # Saved video list + favorites
│   ├── settings/               # Account settings and profile form
│   ├── auth/                   # Auth UI fragments
│   ├── layout.tsx              # Root layout with Auth & theme providers
│   └── page.tsx                # Landing page
├── components/
│   ├── ai-chat.tsx             # Transcript-aware chat UI
│   ├── highlights-panel.tsx    # Highlight reel cards + controls
│   ├── notes-panel.tsx         # Note capture + listing
│   ├── right-column-tabs.tsx   # Summary / Chat / Transcript / Notes tabs
│   ├── youtube-player.tsx      # Player wrapper with shared playback state
│   └── ui/                     # Reusable shadcn/ui primitives
├── contexts/
│   └── auth-context.tsx        # Supabase auth provider
├── lib/
│   ├── ai-client.ts            # Provider-agnostic AI entry point
│   ├── ai-processing.ts        # Prompt building, transcript chunking, candidate pooling
│   ├── ai-providers/           # Grok & Gemini adapters + registry
│   ├── notes-client.ts         # CSRF-protected note helpers
│   ├── rate-limiter.ts         # Supabase-backed request limiting
│   ├── security-middleware.ts  # Common security wrapper for route handlers
│   ├── supabase/               # Browser/server clients + middleware helpers
│   ├── validation.ts           # Zod schemas shared across endpoints
│   └── utils.ts                # URL parsing, formatting, color helpers, etc.
├── public/                     # Static assets (logos, SVGs)
├── supabase/
│   └── migrations/             # Database migrations (e.g., topic_generation_mode column)
├── CLAUDE.md                   # Extended architecture + contributor handbook
└── next.config.ts              # Remote image allowlist, Turbopack rules, webpack tweaks
```

## Local Development

### Prerequisites

- Node.js 18+ (Next.js 15 requires 18.18 or newer)
- `npm` (repo uses package-lock.json), though `pnpm` or `yarn` also work
- Supabase project (Auth + Postgres) and API keys for Supadata & at least one AI provider (xAI Grok recommended, Gemini optional)

### 1. Clone & Install

```bash
git clone https://github.com/SamuelZ12/longcut.git
cd longcut
npm install
```

### 2. Configure Environment

Create `.env.local` in the repo root:

| Variable | Required | Description |
| --- | --- | --- |
| `XAI_API_KEY` | yes* | xAI Grok API key (`grok-4-1-fast-non-reasoning` by default) |
| `GEMINI_API_KEY` | optional* | Google Gemini API key (enable if `AI_PROVIDER=gemini`) |
| `SUPADATA_API_KEY` | yes | Supadata transcript API key |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anonymous key |
| `CSRF_SALT` | yes | Long random string used to sign CSRF tokens |
| `AI_PROVIDER` | optional | `grok` (default) or `gemini`; determines which adapter is used |
| `AI_DEFAULT_MODEL` | optional | Override provider default model (e.g., `grok-4-1-fast-non-reasoning`) |
| `NEXT_PUBLIC_AI_MODEL` | optional | Client-side override for display/config hints |
| `NEXT_PUBLIC_APP_URL` | optional | Canonical app URL (defaults to `http://localhost:3000`) |
| `NEXT_PUBLIC_ENABLE_TRANSLATION_SELECTOR` | optional | Set to `true` to show the transcript translation dropdown (hidden otherwise) |
| `YOUTUBE_API_KEY` | optional | Enables additional metadata when available |
| `UNLIMITED_VIDEO_USERS` | optional | Comma-separated emails or user IDs allowed to bypass daily limits |

<sup>\*</sup> At least one provider key (`XAI_API_KEY` or `GEMINI_API_KEY`) must be present. Set `AI_PROVIDER` if you prefer Gemini; otherwise Grok is used.

> Generate a unique `CSRF_SALT` (e.g., `openssl rand -base64 32`). `UNLIMITED_VIDEO_USERS` entries are normalized to lowercase.

### 3. Supabase Setup

1. Run SQL migrations in `supabase/migrations/` using the Supabase SQL editor or CLI.
2. Ensure the following tables exist (structure documented in `CLAUDE.md`): `video_analyses`, `user_videos`, `user_notes`, `profiles`, and `rate_limits`.
3. Add the Postgres function `upsert_video_analysis_with_user_link` that stores analyses and links them to a user in `user_videos` (the production project contains the reference implementation—export it or recreate it before local testing).
4. Enable email OTP/auth providers required by your login flow and configure redirect URLs to match `NEXT_PUBLIC_APP_URL`.

### 4. Run the App

```bash
npm run dev        # starts Next.js with Turbopack on http://localhost:3000
npm run lint       # optional: run lint checks (ESLint v9)
```

The dev server reaches out to Supadata and your configured AI provider(s) directly, so make sure those API keys have local allowlists if your project settings restrict origins.

## Developer Notes

- All state-changing requests must go through `csrfFetch` so that `withSecurity` can validate the token.
- Rate limiting records are stored in the `rate_limits` table; clear it when resetting dev limits.
- Topic generation mode (`smart` vs `fast`) is persisted per-profile and synced via `useModePreference`.
- `middleware.ts` refreshes Supabase sessions and adds security headers—keep it enabled when deploying to Vercel.
- Detailed architecture notes, prompts, and database expectations live in `CLAUDE.md`; review it before larger changes.

## Contributing

Issues and PRs are welcome. This repo uses the [Anthropic Claude Code Action](https://github.com/anthropics/claude-code-action) for automated pull-request reviews guided by `CLAUDE.md`. Please run `npm run lint` and double-check Supabase migrations before opening a PR.

## License

Distributed under the [GNU Affero General Public License v3.0](LICENSE).
