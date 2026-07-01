/**
 * Part A — one-time backfill: resurface already-stored deleted/removed Reddit
 * posts & comments by recovering their real body (and score) from the free
 * Arctic Shift archive (https://arctic-shift.photon-reddit.com).
 *
 * This is a SELF-CONTAINED, one-shot script (no permanent UI button). It runs
 * against PRODUCTION via the PROD_DATABASE_URL secret. Because production may not
 * yet have the `recovered_at` column at the time this runs, the script only
 * heals `body` (and `score`) — it does NOT write `recovered_at`. Those healed
 * rows therefore won't carry the "recovered from archive" badge; that's
 * expected for this historical backfill.
 *
 * Usage:  pnpm --filter @workspace/scripts exec tsx src/resurface-deleted.ts
 */

import { Pool } from "pg";

const ARCTIC_BASE = "https://arctic-shift.photon-reddit.com";

// Live-Reddit tombstones that replace a deleted/removed body. The real marker
// observed in prod is exactly "[ Removed by Reddit ]" (capital R, inner
// spaces); the classic "[deleted]"/"[removed]" forms are also covered. An
// EMPTY post body is NOT a tombstone (link posts legitimately have none).
const REMOVED_BODY_MARKERS = new Set([
  "[ removed by reddit ]",
  "[removed by reddit]",
  "[removed by moderator]",
  "[ removed by moderator ]",
  "[removed by moderators]",
  "[ removed by moderators ]",
  "[deleted by reddit]",
  "[removed]",
  "[deleted]",
  "[deleted by user]",
  "[ removed ]",
  "[ deleted ]",
]);

function isRemovedBody(body: string | null | undefined): boolean {
  if (body == null) return false;
  return REMOVED_BODY_MARKERS.has(body.trim().toLowerCase());
}

function isRecoverable(body: unknown): body is string {
  if (typeof body !== "string") return false;
  const t = body.trim();
  return t.length > 0 && !isRemovedBody(t);
}

/**
 * Strip a Reddit fullname prefix (`t1_`/`t3_`). Our DB stores the prefixed
 * fullname (e.g. `t1_oq7umev`) but the Arctic archive's by-ids endpoint
 * returns the bare id (`oq7umev`), so we must normalise before matching.
 */
function stripFullname(id: string): string {
  return id.replace(/^t\d+_/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ArcticKind = "posts" | "comments";

async function fetchByIds(
  kind: ArcticKind,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  const BATCH = 100;

  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const url = `${ARCTIC_BASE}/api/${kind}/ids?ids=${batch.join(",")}`;

    let page: Array<Record<string, unknown>> | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { "User-Agent": "AstroOrbiter/1.0 (community-intelligence)" } });
      } catch {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (res.status === 404) {
        page = [];
        break;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        page = [];
        break;
      }
      const json = (await res.json()) as unknown;
      const data = Array.isArray(json) ? json : ((json as { data?: unknown })?.data ?? []);
      page = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      break;
    }

    if (page) {
      for (const item of page) {
        const id = typeof item.id === "string" ? item.id : null;
        if (id) out.set(id, item);
      }
    }

    process.stdout.write(`  fetched ${Math.min(i + BATCH, unique.length)}/${unique.length} ${kind} ids\r`);
    if (i + BATCH < unique.length) await sleep(350);
  }
  process.stdout.write("\n");

  return out;
}

function pickScore(item: Record<string, unknown>): number | null {
  const s = Number(item.score);
  return Number.isFinite(s) ? s : null;
}

async function main(): Promise<void> {
  const connectionString = process.env.PROD_DATABASE_URL;
  if (!connectionString) {
    throw new Error("PROD_DATABASE_URL is not set — cannot run the production backfill.");
  }

  const pool = new Pool({ connectionString });

  try {
    // ---- COMMENTS ----
    const removedLower = [...REMOVED_BODY_MARKERS];
    const commentRows = await pool.query<{ reddit_comment_id: string; body: string }>(
      `SELECT reddit_comment_id, body FROM comments WHERE lower(btrim(body)) = ANY($1::text[])`,
      [removedLower],
    );
    console.log(`Comments: ${commentRows.rowCount} tombstoned rows found.`);

    let commentRecovered = 0;
    let commentUnrecoverable = 0;
    if (commentRows.rowCount && commentRows.rowCount > 0) {
      const ids = commentRows.rows.map((r) => r.reddit_comment_id);
      const archive = await fetchByIds("comments", ids);
      for (const row of commentRows.rows) {
        const item = archive.get(stripFullname(row.reddit_comment_id));
        if (item && isRecoverable(item.body)) {
          const score = pickScore(item);
          await pool.query(
            `UPDATE comments SET body = $1, score = COALESCE($2, score) WHERE reddit_comment_id = $3`,
            [(item.body as string).trim(), score, row.reddit_comment_id],
          );
          commentRecovered++;
        } else {
          commentUnrecoverable++;
        }
      }
    }

    // ---- POSTS ----
    const postRows = await pool.query<{ reddit_post_id: string; body: string | null }>(
      `SELECT reddit_post_id, body FROM posts WHERE lower(btrim(body)) = ANY($1::text[])`,
      [removedLower],
    );
    console.log(`Posts: ${postRows.rowCount} tombstoned rows found.`);

    let postRecovered = 0;
    let postUnrecoverable = 0;
    if (postRows.rowCount && postRows.rowCount > 0) {
      const ids = postRows.rows.map((r) => r.reddit_post_id);
      const archive = await fetchByIds("posts", ids);
      for (const row of postRows.rows) {
        const item = archive.get(stripFullname(row.reddit_post_id));
        // Posts use `selftext` for body in the Arctic archive.
        const recoveredBody = item
          ? (isRecoverable(item.selftext) ? (item.selftext as string) : (isRecoverable(item.body) ? (item.body as string) : null))
          : null;
        if (recoveredBody) {
          const score = pickScore(item!);
          await pool.query(
            `UPDATE posts SET body = $1, score = COALESCE($2, score) WHERE reddit_post_id = $3`,
            [recoveredBody.trim(), score, row.reddit_post_id],
          );
          postRecovered++;
        } else {
          postUnrecoverable++;
        }
      }
    }

    console.log("\n===== Part A backfill complete =====");
    console.log(`Comments: recovered ${commentRecovered}, unrecoverable ${commentUnrecoverable}`);
    console.log(`Posts:    recovered ${postRecovered}, unrecoverable ${postUnrecoverable}`);
    console.log("(recovered_at not written — prod column may not exist yet; badges apply to future recoveries only.)");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
