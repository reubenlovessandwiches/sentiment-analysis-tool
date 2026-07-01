/**
 * One-time backfill: populate the new `comments.permalink` column for rows that
 * predate it (permalink IS NULL) by looking each comment up in the free Arctic
 * Shift archive (https://arctic-shift.photon-reddit.com) and storing the real
 * deep-link it returns.
 *
 * Why: a comment's stored `parent_id` is the *post* only for top-level comments
 * (`t3_…`). For replies it is the parent *comment* (`t1_…`), so the post id
 * needed to reconstruct a deep-link is unavailable and the link falls back to
 * the bare subreddit URL. The archive returns each comment's true `permalink`,
 * which already encodes the post id, so storing it fixes replies too.
 *
 * SELF-CONTAINED, one-shot script (no permanent UI button). Runs against
 * PRODUCTION via the PROD_DATABASE_URL secret. Fetching the archive costs
 * nothing. Comments not present in the archive are left NULL; the read side then
 * reconstructs a best-effort link from parent_id (correct for top-level
 * comments).
 *
 * Usage:  pnpm --filter @workspace/scripts exec tsx src/backfill-comment-permalinks.ts
 */

import { Pool } from "pg";

const ARCTIC_BASE = "https://arctic-shift.photon-reddit.com";

/** Strip a Reddit fullname prefix (`t1_`/`t3_`) — the archive uses bare ids. */
function stripFullname(id: string): string {
  return id.replace(/^t\d+_/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Absolute reddit.com URL for an archive item's (relative) permalink, or null. */
function arcticPermalink(item: Record<string, unknown>): string | null {
  const p = typeof item.permalink === "string" ? item.permalink.trim() : "";
  if (!p) return null;
  return p.startsWith("http") ? p : `https://www.reddit.com${p}`;
}

/**
 * Mirror of the api-server `isCommentPermalink`: true only for a comment-level
 * deep link, false for a bare thread/post URL. Used so the backfill also repairs
 * rows that hold a non-null but post-level permalink (not just NULL rows).
 */
function isCommentPermalink(url: string | null | undefined): boolean {
  if (!url) return false;
  return /\/comments\/[^/]+\/[^/]+\/[a-z0-9]+/i.test(url) || /\/comment\/[a-z0-9]+/i.test(url);
}

async function fetchByIds(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  const BATCH = 100;

  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const url = `${ARCTIC_BASE}/api/comments/ids?ids=${batch.join(",")}`;

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

    process.stdout.write(`  fetched ${Math.min(i + BATCH, unique.length)}/${unique.length} comment ids\r`);
    if (i + BATCH < unique.length) await sleep(350);
  }
  process.stdout.write("\n");

  return out;
}

async function main(): Promise<void> {
  const connectionString = process.env.PROD_DATABASE_URL;
  if (!connectionString) {
    throw new Error("PROD_DATABASE_URL is not set — cannot run the production backfill.");
  }

  const pool = new Pool({ connectionString });

  try {
    // Repair rows that are either NULL or hold a non-comment-level (thread/post)
    // URL — both need a real comment deep-link from the archive.
    // "Comment-level" matches the JS isCommentPermalink guard: EITHER
    // /comments/<post>/<slug>/<id> OR /comment/<id>. A row needs repair when it
    // is NULL or matches neither form.
    const rows = await pool.query<{ reddit_comment_id: string; permalink: string | null }>(
      `SELECT reddit_comment_id, permalink FROM comments
        WHERE permalink IS NULL
           OR (permalink !~* '/comments/[^/]+/[^/]+/[a-z0-9]+'
               AND permalink !~* '/comment/[a-z0-9]+')`,
    );
    console.log(`Comments needing permalink repair: ${rows.rowCount}`);
    if (!rows.rowCount) {
      console.log("Nothing to backfill.");
      return;
    }

    const ids = rows.rows.map((r) => r.reddit_comment_id);
    const archive = await fetchByIds(ids);

    let updated = 0;
    let cleared = 0;
    let notFound = 0;
    for (const row of rows.rows) {
      const item = archive.get(stripFullname(row.reddit_comment_id));
      const permalink = item ? arcticPermalink(item) : null;
      if (permalink && isCommentPermalink(permalink)) {
        await pool.query(`UPDATE comments SET permalink = $1 WHERE reddit_comment_id = $2`, [
          permalink,
          row.reddit_comment_id,
        ]);
        updated++;
      } else if (row.permalink !== null) {
        // A non-null but non-comment-level value with no archive fix: clear it so
        // the read side reconstructs a best-effort link from parent_id instead.
        await pool.query(`UPDATE comments SET permalink = NULL WHERE reddit_comment_id = $1`, [
          row.reddit_comment_id,
        ]);
        cleared++;
      } else {
        notFound++;
      }
    }

    console.log("\n===== Comment permalink backfill complete =====");
    console.log(
      `Updated: ${updated}, cleared bad non-comment URLs: ${cleared}, ` +
        `not in archive (left NULL, reconstructed on read): ${notFound}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
