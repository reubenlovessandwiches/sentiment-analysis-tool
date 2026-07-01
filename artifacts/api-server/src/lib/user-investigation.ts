import { db, redditUsersTable, postsTable, commentsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { pickStr, pickNum, findOrCreateSubreddit, INCOMING_BODY_IS_TOMBSTONE, isCommentPermalink } from "./crawl";
import { fetchUserContent, arcticPermalink, arcticDate } from "./arcticshift";

/**
 * Newest stored `posted_at` (as unix seconds) for this user in one content
 * table, used as the Arctic Shift `after` cursor for incremental refreshes so we
 * only fetch content newer than what we already have. The cursor is per content
 * type (posts vs comments) — a shared cursor would skip, e.g., posts older than
 * the latest stored comment when an operator switches content modes between
 * runs. Matching is case-insensitive because Reddit usernames are.
 */
async function getUserKindCursor(table: "posts" | "comments", username: string): Promise<number | undefined> {
  const rows = await db.execute<{ max_ts: string | null }>(
    table === "posts"
      ? sql`SELECT EXTRACT(EPOCH FROM MAX(posted_at))::bigint AS max_ts FROM posts WHERE lower(author) = lower(${username})`
      : sql`SELECT EXTRACT(EPOCH FROM MAX(posted_at))::bigint AS max_ts FROM comments WHERE lower(author) = lower(${username})`,
  );
  const v = rows.rows?.[0]?.max_ts;
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Recompute a Reddit user's denormalized stats from their actual stored rows.
 * Re-investigating a user would otherwise double-count if we incremented
 * counters per ingest, so after every investigation we derive total_posts /
 * total_comments / first_seen / last_seen authoritatively from the tables.
 * Ensures the user row exists first (a user with zero archived items still gets
 * a row so the investigation result is visible).
 */
async function recomputeRedditUserStats(username: string): Promise<void> {
  await db.insert(redditUsersTable).values({ username }).onConflictDoNothing();
  // Reddit usernames are case-insensitive, so match author case-insensitively —
  // otherwise investigating "Spez" when rows store "spez" would zero the totals.
  await db.execute(sql`
    UPDATE reddit_users u SET
      total_posts = (SELECT COUNT(*) FROM posts WHERE lower(author) = lower(${username})),
      total_comments = (SELECT COUNT(*) FROM comments WHERE lower(author) = lower(${username})),
      first_seen = (
        SELECT MIN(ts) FROM (
          SELECT posted_at AS ts FROM posts WHERE lower(author) = lower(${username})
          UNION ALL SELECT posted_at FROM comments WHERE lower(author) = lower(${username})
        ) f
      ),
      last_seen = (
        SELECT MAX(ts) FROM (
          SELECT posted_at AS ts FROM posts WHERE lower(author) = lower(${username})
          UNION ALL SELECT posted_at FROM comments WHERE lower(author) = lower(${username})
        ) l
      )
    WHERE lower(u.username) = lower(${username})
  `);
}

/**
 * Ingest Arctic Shift posts for an author. Spans many subreddits (one per item,
 * including the user's `u_<name>` profile), so it can't reuse the single-
 * subreddit `ingestRedditItems`. Dedupes on `reddit_post_id`; on conflict it
 * refreshes score/title but never overwrites a previously-recovered body with a
 * `[deleted]`/`[removed]` placeholder. Returns rows processed.
 */
async function ingestArcticPosts(items: Array<Record<string, unknown>>): Promise<number> {
  let n = 0;
  for (const item of items) {
    const id = pickStr(item, "id");
    const title = pickStr(item, "title");
    const author = pickStr(item, "author");
    if (!id || !title || !author || author === "[deleted]") continue;
    const sub = await findOrCreateSubreddit(pickStr(item, "subreddit") ?? "unknown");
    await db
      .insert(postsTable)
      .values({
        subredditId: sub.id,
        redditPostId: id,
        title,
        body: pickStr(item, "selftext", "body"),
        author,
        score: pickNum(item, "score", "ups"),
        permalink: arcticPermalink(item),
        postedAt: arcticDate(item),
      })
      .onConflictDoUpdate({
        target: postsTable.redditPostId,
        set: {
          score: sql`excluded.score`,
          title: sql`excluded.title`,
          body: sql`CASE WHEN ${INCOMING_BODY_IS_TOMBSTONE}
                         THEN ${postsTable.body} ELSE excluded.body END`,
        },
      });
    n++;
  }
  return n;
}

/** Ingest Arctic Shift comments for an author. Mirrors {@link ingestArcticPosts}. */
async function ingestArcticComments(items: Array<Record<string, unknown>>): Promise<number> {
  let n = 0;
  for (const item of items) {
    const id = pickStr(item, "id");
    const body = pickStr(item, "body");
    const author = pickStr(item, "author");
    if (!id || !body || !author || author === "[deleted]") continue;
    const sub = await findOrCreateSubreddit(pickStr(item, "subreddit") ?? "unknown");
    await db
      .insert(commentsTable)
      .values({
        subredditId: sub.id,
        redditCommentId: id,
        author,
        body,
        score: pickNum(item, "score", "ups"),
        parentId: pickStr(item, "parent_id", "link_id"),
        permalink: isCommentPermalink(arcticPermalink(item)) ? arcticPermalink(item) : null,
        postedAt: arcticDate(item),
      })
      .onConflictDoUpdate({
        target: commentsTable.redditCommentId,
        set: {
          score: sql`excluded.score`,
          body: sql`CASE WHEN ${INCOMING_BODY_IS_TOMBSTONE}
                         THEN ${commentsTable.body} ELSE excluded.body END`,
          permalink: sql`COALESCE(${commentsTable.permalink}, excluded.permalink)`,
        },
      });
    n++;
  }
  return n;
}

/**
 * Whether this user has ever been crawled via the Arctic Shift archive. Used to
 * pick a full historical crawl (never crawled) vs an incremental refresh
 * (crawled before). Distinct from merely having content — a user can have posts
 * from a subreddit/Apify crawl yet have never had their own history pulled.
 */
export async function hasArcticCrawl(username: string): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(
    sql`SELECT (arctic_crawled_at IS NOT NULL) AS ok FROM reddit_users WHERE lower(username) = lower(${username}) LIMIT 1`,
  );
  return rows.rows?.[0]?.ok === true;
}

async function markArcticCrawled(username: string): Promise<void> {
  await db.execute(sql`UPDATE reddit_users SET arctic_crawled_at = now() WHERE lower(username) = lower(${username})`);
}

export interface CrawlUserParams {
  username: string;
  contentType: "posts" | "comments" | "both";
  maxItems: number;
  refresh: "incremental" | "full";
  /** Reports cumulative item count as ingestion progresses. */
  onProgress?: (count: number) => Promise<void>;
}

/**
 * Crawl a single Reddit user's history from the Arctic Shift archive (free,
 * includes since-deleted content), ingest with full dedup/tombstone protection,
 * recompute their stats, and stamp `arctic_crawled_at`. Incremental refreshes
 * fetch only content newer than what's already stored (per-content-type cursor);
 * a full crawl pulls everything. Arctic Shift is the only source for this — no
 * fallback — so an outage propagates as a thrown error for the caller to surface.
 */
export async function crawlUserViaArcticShift({
  username,
  contentType,
  maxItems,
  refresh,
  onProgress,
}: CrawlUserParams): Promise<{ posts: number; comments: number; canonical: string }> {
  const wantPosts = contentType !== "comments";
  const wantComments = contentType !== "posts";

  let posts = 0;
  let comments = 0;
  let processed = 0;
  // Canonicalize to the casing Reddit actually stores (from the archived data),
  // so the stats row and classification target match the ingested `author`
  // values. Falls back to the entered name when no items are returned.
  let canonical = username;
  const adopt = (items: Array<Record<string, unknown>>) => {
    const found = items.find((i) => typeof i.author === "string" && i.author && i.author !== "[deleted]")?.author;
    if (typeof found === "string") canonical = found;
  };

  if (wantPosts) {
    const after = refresh === "incremental" ? await getUserKindCursor("posts", username) : undefined;
    const base = processed;
    const postItems = await fetchUserContent("posts", username, maxItems, after, onProgress ? (c) => onProgress(base + c) : undefined);
    adopt(postItems);
    posts = await ingestArcticPosts(postItems);
    processed += posts;
    if (onProgress) await onProgress(processed);
  }

  if (wantComments) {
    const after = refresh === "incremental" ? await getUserKindCursor("comments", username) : undefined;
    const base = processed;
    const commentItems = await fetchUserContent("comments", username, maxItems, after, onProgress ? (c) => onProgress(base + c) : undefined);
    adopt(commentItems);
    comments = await ingestArcticComments(commentItems);
    processed += comments;
    if (onProgress) await onProgress(processed);
  }

  await recomputeRedditUserStats(canonical);
  await markArcticCrawled(canonical);

  return { posts, comments, canonical };
}
