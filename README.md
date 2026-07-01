# App

Multi-platform (Reddit + Facebook + Instagram) community intelligence platform for analysing discussion patterns, classifying users into a fixed, community-specific set of archetypes (derived once at setup, with a generic default provided) using AI, and surfacing community dynamics through dashboards and user comparison. Reddit/Facebook entities are keyed on username/profileId respectively; Instagram entities are keyed on username. (Internal package/dir name remains `web-app`; user-facing brand is "App".)

## First-time setup: choose your archetypes

This app classifies community members against a **fixed archetype taxonomy**. You
derive that taxonomy **once**, at setup, by pointing the app at the kind of
community you intend to analyse. The generated set is then constant for every
future crawl and classification (it does not change per post or per run).

```
pnpm --filter @workspace/api-server run derive-archetypes "<source>" "[description]"
```

Examples:

```
pnpm --filter @workspace/api-server run derive-archetypes "r/politics" "US national politics"
pnpm --filter @workspace/api-server run derive-archetypes "r/gaming" "Video game enthusiast community"
```

This uses the configured OpenAI model to generate a set of archetypes fitted to
that community and writes them to `artifacts/api-server/src/lib/archetypes.ts`,
overwriting whatever was there. Restart the API server afterwards. Re-run the
command any time to regenerate for a different community. If you skip this step, a
generic default taxonomy ships with the repo. Requires `OPENAI_API_KEY` /
`OPENAI_BASE_URL` to be set.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, served at /api)
- `pnpm --filter @workspace/web-app run dev` — run the Vite frontend (port 20113, served at /)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run typecheck:libs` — build composite libs (required before api-server typecheck)
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/scripts exec tsx src/seed.ts` — seed demo data
- `pnpm --filter @workspace/api-server run derive-archetypes "<source>" "[description]"` — one-time setup: derive the fixed archetype taxonomy (see above)
- Required env: `DATABASE_URL` — Postgres connection string
- Auth: DB-backed accounts (`app_users`). `APP_USERNAME`/`APP_PASSWORD` only seed the main admin on first run when `app_users` is empty; afterward, manage accounts in the User Management page
- Required env: `OPENAI_BASE_URL`, `OPENAI_API_KEY` — via the platform OpenAI AI integration
- Optional env: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` — for live crawling

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, wouter routing, shadcn/ui, Recharts, TanStack Query, dark mode default
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- AI: OpenAI via an OpenAI-compatible API (`@workspace/integrations-openai-ai-server`)
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for all API contracts
- `lib/api-zod/src/generated/api.ts` — generated Zod schemas (run codegen to update)
- `lib/api-client-react/src/generated/api.ts` — generated React Query hooks (run codegen to update)
- `lib/db/src/schema/` — Drizzle table definitions (subreddits, reddit_users, posts, comments, analyses, archetype_scores, clusters, jobs)
- `artifacts/api-server/src/routes/` — Express route handlers, one file per domain
- `artifacts/api-server/src/lib/archetypes.ts` — archetype definitions (14 archetypes, indicators, relations)
- `artifacts/api-server/src/lib/analysis.ts` — OpenAI-powered user analysis logic
- `artifacts/web-app/src/pages/` — one file per page (dashboard, users, user-profile, archetypes, compare, search, admin)
- `scripts/src/seed.ts` — demo data seed script

## Architecture decisions

- Contract-first API: OpenAPI spec → Orval codegen → typed hooks on frontend, Zod schemas on backend
- Orval zod config: removed `schemas` output to avoid TS2308 collision between generated types and Zod schemas
- Analysis runs async: POST /api/users/:username/analyze creates a job record and runs in the background, returning 202
- No Redis/BullMQ for v1 jobs: uses simple async functions for both crawl and analysis; upgrading to BullMQ requires adding `REDIS_URL` env var
- Crawl gracefully degrades: if `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` not set, crawl job fails with a clear error message

## Product

- **Dashboard** — aggregate stats, archetype distribution bar chart, activity-over-time chart, top users
- **Entity Directory** — all profiled users with dominant archetype badges and confidence scores
- **User Profile** — full analysis with radar chart, confidence bars, recurring themes, recent content
- **Archetype Explorer** — 14 archetype cards with population counts, avg scores, top themes
- **Compare** — side-by-side radar chart and similarity score for two users
- **Topic Analysis** — input a topic summary + up to 20 Reddit post URLs; crawls their comments via Apify, AI-groups into 3–5 themes, flags concerning comments, renders a printable report with steering summary and per-theme breakdowns; supports re-running with the same settings
- **Admin Panel** — manage subreddits, launch crawls, view job queue (live unclassified count, dimmed finished-job snapshots, clear-finished control)
- **User Management** (main admin only) — DB-backed multi-account auth (1 admin + members). Add/delete accounts; view a paginated (5/page) audit log of all login attempts (success/fail, IP, UTC timestamp)

## Gotchas

- Always run `pnpm run typecheck:libs` before `pnpm --filter @workspace/api-server run typecheck` — the api-server depends on composite libs
- OpenAI integration lib image client errors: use `response.data?.[0]` not `response.data[0]` (data is possibly undefined in newer types)
- `useSearchUsers` returns `SearchUsersResponseItem[]` directly (array), NOT `{ users: [...] }`
- `ListUsersResponse` is `{ users: UserWithScore[], total: number }` — access via `data.users` and `data.total`
- Seed script needs `@workspace/db` in scripts/package.json dependencies
- Reddit blocks some datacenter IPs (403) — crawling goes through an Apify actor (token entered in Admin Panel, stored in DB `settings` table). Observed costs: ~$1/170 posts (subreddit crawl, posts only, free actor); ~$1/3 threads (Topic Analysis with comments). Costs vary with volume and Apify plan.
- Apify actor IDs must be normalized slash→tilde (`trudax/reddit-scraper-lite` → `trudax~reddit-scraper-lite`) before use in the REST API path, or Apify returns 404 "actor not found"
- Crawl and classification are separate steps: the crawl job only ingests posts/users (plus comments if the actor returns them), then auto-triggers `classifyUnanalyzedUsers()` (OpenAI) so users don't stay unclassified
- Default Apify actor is the FREE `trudax~reddit-scraper-lite`, which DOES return comments (user-tested Jun 2026 — corrects an earlier "posts only" assumption). The full `trudax~reddit-scraper` is a PAID/rental actor: using it without renting it on the Apify account returns 403, mapped to a "denied access to actor … (403)" error. Comment ingestion activates automatically for any comment-returning actor. The actor is stored in DB `settings.apify_actor_id` — changing `DEFAULT_APIFY_ACTOR_ID` does NOT override an already-saved value; update the settings row (or Admin Panel field) too
- Topic Analysis can crawl ONLY the input URLs that were skipped (those without a `topic_analysis_posts` row) and merge them into an existing run — "Crawl skipped links" button on the report (POST /topic-analyses/:id/crawl-missing). It seeds the AI pool with the run's stored comments and crawls only the missing URLs, so successful links aren't re-billed on Apify. Reports live in the PROD DB, so fixing a specific report needs a publish + clicking the button in production
- The api-server workflow builds on startup and does NOT hot-reload — restart it after backend changes

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `lib/api-spec/openapi.yaml` for the full API contract
