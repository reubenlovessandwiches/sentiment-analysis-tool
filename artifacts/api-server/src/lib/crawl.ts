import { db, subredditsTable, redditUsersTable, facebookUsersTable, instagramUsersTable, tiktokUsersTable, twitterUsersTable, youtubeUsersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { fetchByIds, type ArcticKind } from "./arcticshift";
import { logger } from "./logger";
import { recordApifyCost } from "./cost-tracking";

const APIFY_BASE = "https://api.apify.com/v2";

/**
 * Effectively-unlimited safety ceiling on comments fetched from a single thread
 * in comments-only mode. We do NOT cap to a small fixed number: a thread should
 * yield however many comments it actually has (10, 50, 300, …). This high bound
 * exists only so one runaway thread can't request truly unbounded work, and is
 * used uniformly for both the Reddit (maxItems/maxComments) and Facebook
 * (resultsLimit) actors rather than relying on each actor's differing "0 means
 * unlimited" convention.
 */
export const COMMENT_CRAWL_LIMIT = 100_000;

interface ApifyRun {
  data: { id: string; status: string; defaultDatasetId: string };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an Apify actor and return its scraped dataset items.
 *
 * Reddit blocks automated requests from datacenter IPs (which is where this app
 * runs), so we delegate scraping to an Apify actor that routes through
 * residential proxies. Requires an Apify API token configured in the Admin Panel.
 */
export async function runApifyActor(
  token: string,
  actorId: string,
  input: Record<string, unknown>,
  onStatus?: (status: string) => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  // Send the token via Authorization header (not the URL) so it isn't captured
  // in proxy/access logs.
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Apify's REST API path expects the "username~actorname" form. Users commonly
  // copy the "username/actorname" form from the Apify Store URL, so normalize
  // slashes to tildes to accept either.
  const apiActorId = actorId.trim().replace(/\//g, "~");
  const startRes = await fetch(`${APIFY_BASE}/acts/${apiActorId}/runs`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (startRes.status === 401) {
    throw new Error("Apify rejected the API key (unauthorized). Check the key in the Admin Panel.");
  }
  if (startRes.status === 403) {
    throw new Error(
      `Apify denied access to actor "${actorId}" (403). The API key is valid but this actor isn't available to your account — paid/rental actors must be added on the Apify Store first, or switch to a free actor like trudax~reddit-scraper-lite (posts only) in the Admin Panel.`,
    );
  }
  if (startRes.status === 404) {
    throw new Error(`Apify actor "${actorId}" not found. Check the actor ID in the Admin Panel.`);
  }
  if (!startRes.ok) {
    throw new Error(`Apify run failed to start: ${startRes.status} ${startRes.statusText}`);
  }

  const run = (await startRes.json()) as ApifyRun;
  const runId = run.data.id;
  const datasetId = run.data.defaultDatasetId;

  // Poll until the run reaches a terminal state. Larger crawls (e.g. a few
  // hundred posts) routinely take longer than a few minutes, so we wait up to
  // 30 minutes before giving up. We poll every 5s to keep request volume sane.
  const terminal = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
  const POLL_INTERVAL_MS = 5000;
  const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes
  const maxPolls = Math.ceil(MAX_WAIT_MS / POLL_INTERVAL_MS);
  let status = run.data.status;
  let polls = 0;
  while (!terminal.has(status) && polls < maxPolls) {
    await sleep(POLL_INTERVAL_MS);
    polls++;
    const statusRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}`, { headers: authHeaders });
    if (!statusRes.ok) continue;
    const statusData = (await statusRes.json()) as ApifyRun;
    status = statusData.data.status;
    if (onStatus) await onStatus(status);
  }

  if (status !== "SUCCEEDED") {
    // If the run is still in a non-terminal state we hit our local wait limit —
    // the Apify run itself may well finish successfully. Make that distinction
    // clear so it isn't mistaken for an actual Apify-side failure.
    if (!terminal.has(status)) {
      throw new Error(
        `Stopped waiting after 30 min while the Apify run was still ${status}. The run may still finish on Apify — check your Apify account; if it succeeded, re-run the crawl to ingest its results.`,
      );
    }
    throw new Error(`Apify run did not succeed (status: ${status}). Check your Apify account for run details.`);
  }

  // Record the run's actual USD cost (usageTotalUsd), attributed to the app
  // account in the current cost context. Fire-and-forget so it never delays or
  // breaks the crawl; the cost context is captured synchronously on entry.
  void recordApifyCost(token, runId);

  const itemsRes = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?clean=true`, { headers: authHeaders });
  if (!itemsRes.ok) {
    throw new Error(`Failed to fetch Apify dataset: ${itemsRes.status} ${itemsRes.statusText}`);
  }
  return (await itemsRes.json()) as Array<Record<string, unknown>>;
}

/**
 * Fetch the dataset items of an EXISTING, already-finished Apify run by its run
 * ID. This only reads a stored dataset — it never starts an actor — so it costs
 * no Apify credits. Use it to re-ingest a run that already succeeded (e.g. one
 * the app's own crawl missed, or one started manually on Apify) without paying
 * to crawl again.
 */
export async function fetchApifyRunItems(
  token: string,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const id = runId.trim();
  const runRes = await fetch(`${APIFY_BASE}/actor-runs/${id}`, { headers: authHeaders });
  if (runRes.status === 401) {
    throw new Error("Apify rejected the API key (unauthorized). Check the key in the Admin Panel.");
  }
  if (runRes.status === 404) {
    throw new Error(`Apify run "${id}" not found. Check the Run ID — it's the run's ID on Apify, not the actor or dataset ID.`);
  }
  if (!runRes.ok) {
    throw new Error(`Failed to fetch Apify run: ${runRes.status} ${runRes.statusText}`);
  }
  const run = (await runRes.json()) as ApifyRun;
  const status = run.data.status;
  const datasetId = run.data.defaultDatasetId;
  if (status !== "SUCCEEDED") {
    throw new Error(`Apify run "${id}" is not in a SUCCEEDED state (status: ${status}); only finished, successful runs can be re-ingested.`);
  }
  if (!datasetId) {
    throw new Error(`Apify run "${id}" has no dataset to ingest.`);
  }
  const itemsRes = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?clean=true`, { headers: authHeaders });
  if (!itemsRes.ok) {
    throw new Error(`Failed to fetch Apify dataset: ${itemsRes.status} ${itemsRes.statusText}`);
  }
  return (await itemsRes.json()) as Array<Record<string, unknown>>;
}

/** First defined string field among the candidates, or null. */
export function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

export function pickNum(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return 0;
}

/**
 * Canonical lowercased/trimmed tombstone bodies Reddit/Apify leave behind when
 * content is deleted or removed. The real-world marker on this data is
 * "[ Removed by Reddit ]" (capital R, spaces *inside* the brackets) — confirmed
 * against the production DB — which the old ['[deleted]','[removed]'] guards
 * missed entirely. We match case-insensitively and tolerate the inner-spaced
 * variant. NOTE: an *empty* body is deliberately NOT in this set — empty post
 * bodies are legitimate link posts, not deletions.
 */
export const REMOVED_BODY_MARKERS = [
  "[deleted]",
  "[removed]",
  "[removed by reddit]",
  "[ removed by reddit ]",
  "[removed by moderator]",
  "[ removed by moderator ]",
  "[removed by moderators]",
  "[ removed by moderators ]",
  "[deleted by user]",
  "[deleted by reddit]",
];

/** True if a body is an explicit deletion/removal tombstone (never for ""/null). */
export function isRemovedBody(body: string | null | undefined): boolean {
  if (!body) return false;
  return REMOVED_BODY_MARKERS.includes(body.trim().toLowerCase());
}

/**
 * Strip a Reddit fullname prefix (`t1_` comment, `t3_` post, etc.) so an id
 * matches the Arctic Shift archive's bare ids. Our DB and the Apify crawl store
 * the prefixed fullname (e.g. `t1_oq7umev`), but the archive's by-ids endpoint
 * always returns the bare id (`oq7umev`) — without this normalisation every
 * recovery lookup would miss.
 */
export function stripFullname(id: string): string {
  return id.replace(/^t\d+_/, "");
}

/**
 * Recover the real body+score of tombstoned items from the Arctic Shift archive.
 * Given a list of Reddit ids (posts or comments) that came back tombstoned from
 * the live crawl, look each up in the archive and return a Map of id -> recovered
 * { body, score } — only for ids whose archived body is itself a real (non-
 * tombstone) value. Best-effort: any archive failure is logged and yields an
 * empty/partial map so the crawl never fails because recovery did.
 */
export async function recoverRemovedBodies(
  kind: ArcticKind,
  ids: string[],
): Promise<Map<string, { body: string; score: number }>> {
  const out = new Map<string, { body: string; score: number }>();
  if (ids.length === 0) return out;
  // Map the archive's bare ids back to the caller's original (prefixed) ids so
  // callers can look up results by the same id they stored / passed in.
  const byStripped = new Map<string, string>();
  for (const id of ids) byStripped.set(stripFullname(id), id);
  try {
    const items = await fetchByIds(kind, ids);
    for (const [id, item] of items) {
      const original = byStripped.get(stripFullname(id)) ?? id;
      const body = pickStr(item, "body", "selftext");
      if (body && !isRemovedBody(body)) {
        out.set(original, { body, score: pickNum(item, "score", "ups", "upVotes") });
      }
    }
  } catch (err) {
    logger.warn({ err, kind, count: ids.length }, "Arctic deletion-recovery failed; keeping placeholders");
  }
  return out;
}

/**
 * SQL predicate: is the *incoming* (`excluded.body`) value a placeholder we must
 * not let clobber an existing real/recovered body? True for NULL, empty, or any
 * tombstone marker. Used in onConflict CASE expressions so a re-crawl that only
 * sees a tombstone keeps the better stored text.
 */
export const INCOMING_BODY_IS_TOMBSTONE = sql`(
  excluded.body IS NULL
  OR btrim(excluded.body) = ''
  OR lower(btrim(excluded.body)) IN (${sql.join(
    REMOVED_BODY_MARKERS.map((m) => sql`${m}`),
    sql`, `,
  )})
)`;

export function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * True only for a Reddit *comment-level* deep link — i.e. one that points at a
 * specific comment, either `…/comments/<post>/<slug>/<commentId>/` (Arctic
 * Shift / Reddit's own format) or `…/comment/<commentId>/` (our reconstructed
 * form). A bare thread/post URL (`…/comments/<post>/<slug>/`) returns false.
 * Some scrapers drop a post URL into a comment's `url` field; storing/using it
 * would replace a correct deep-link with a less-specific thread link, so every
 * write and read of a stored comment permalink is gated on this.
 */
export function isCommentPermalink(url: string | null | undefined): boolean {
  if (!url) return false;
  return /\/comments\/[^/]+\/[^/]+\/[a-z0-9]+/i.test(url) || /\/comment\/[a-z0-9]+/i.test(url);
}

/**
 * Build a comment-level deep link for display. If the stored permalink is
 * already comment-level, return it unchanged. Otherwise reconstruct one:
 *  1. If `parentId` is a post fullname (`t3_…`), use it as the post id.
 *  2. Else salvage the post id from a stored *thread* URL
 *     (`…/comments/<postId>/<slug>/`) that lacks a comment id — some scrapers
 *     (e.g. r/AskReddit replies) store the bare thread URL, which would
 *     otherwise dead-end at the bare subreddit link.
 * Only when no post id can be recovered do we fall back to `/r/<sub>/`.
 */
export function buildCommentPermalink(
  storedPermalink: string | null,
  subredditName: string | null,
  parentId: string | null,
  redditCommentId: string,
): string | null {
  if (isCommentPermalink(storedPermalink)) return storedPermalink!;
  if (!subredditName) return null;
  const commentId = redditCommentId.replace(/^t1_/, "");
  let postId = parentId?.startsWith("t3_") ? parentId.slice(3) : null;
  if (!postId && storedPermalink) {
    const m = storedPermalink.match(/\/comments\/([a-z0-9]+)/i);
    if (m) postId = m[1];
  }
  if (postId) {
    return `https://www.reddit.com/r/${subredditName}/comments/${postId}/comment/${commentId}/`;
  }
  return `https://www.reddit.com/r/${subredditName}/`;
}

/** Extract the YouTube video ID from a watch/youtu.be/shorts/live/embed URL, or null. */
export function extractYoutubeVideoId(u: string | null): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    const v = parsed.searchParams.get("v");
    if (v) return v;
    if (parsed.hostname.includes("youtu.be")) {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id || null;
    }
    const m = parsed.pathname.match(/\/(?:shorts|live|embed)\/([^/?]+)/);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}

/** Build a direct YouTube comment permalink (watch?v=<videoId>&lc=<commentId>) when possible. */
export function buildYoutubeCommentUrl(videoUrl: string | null, commentId: string): string | null {
  const videoId = extractYoutubeVideoId(videoUrl);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`;
}

export async function upsertUser(username: string, kind: "post" | "comment") {
  await db
    .insert(redditUsersTable)
    .values({
      username,
      firstSeen: new Date(),
      lastSeen: new Date(),
      totalPosts: kind === "post" ? 1 : 0,
      totalComments: kind === "comment" ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: redditUsersTable.username,
      set: {
        lastSeen: new Date(),
        ...(kind === "post"
          ? { totalPosts: sql`${redditUsersTable.totalPosts} + 1` }
          : { totalComments: sql`${redditUsersTable.totalComments} + 1` }),
      },
    });
}

/**
 * Extract the subreddit and post id from a Reddit thread URL. Accepts the
 * canonical /r/<sub>/comments/<id>/ form on any reddit.com subdomain
 * (www/old/np). Short redd.it links are rejected because they carry no
 * subreddit. Returns a normalized canonical URL the Apify actor understands.
 */
export function parseRedditPostUrl(
  url: string,
): { subreddit: string; postId: string; normalizedUrl: string } | null {
  const m = url.match(/reddit\.com\/r\/([A-Za-z0-9_]+)\/comments\/([A-Za-z0-9]+)/i);
  if (!m) return null;
  const subreddit = m[1];
  const postId = m[2];
  return { subreddit, postId, normalizedUrl: `https://www.reddit.com/r/${subreddit}/comments/${postId}/` };
}

/**
 * Find a subreddit row by name (case-insensitive, since Reddit names are), or
 * create one if it isn't tracked yet — comments need a subreddit FK, and a
 * comments-only thread may belong to a subreddit that isn't on the watch list.
 */
export async function findOrCreateSubreddit(name: string): Promise<{ id: number; subredditName: string }> {
  const [existing] = await db
    .select()
    .from(subredditsTable)
    .where(sql`lower(${subredditsTable.subredditName}) = lower(${name})`);
  if (existing) return { id: existing.id, subredditName: existing.subredditName };

  const [created] = await db
    .insert(subredditsTable)
    .values({ subredditName: name, displayName: name, active: true })
    .onConflictDoNothing()
    .returning();
  if (created) return { id: created.id, subredditName: created.subredditName };

  // Lost an insert race: another request created it first — read it back.
  const [row] = await db
    .select()
    .from(subredditsTable)
    .where(sql`lower(${subredditsTable.subredditName}) = lower(${name})`);
  return { id: row.id, subredditName: row.subredditName };
}

/** Build the Apify input for scraping comments from a single thread URL. */
export function buildCommentCrawlInput(postUrl: string): Record<string, unknown> {
  return {
    startUrls: [{ url: postUrl }],
    skipComments: false,
    skipUserPosts: true,
    skipCommunity: true,
    searchPosts: true,
    searchComments: false,
    searchCommunities: false,
    searchUsers: false,
    sort: "new",
    maxItems: COMMENT_CRAWL_LIMIT + 1,
    maxPostCount: 1,
    maxComments: COMMENT_CRAWL_LIMIT,
    proxy: { useApifyProxy: true },
  };
}

/** True if the URL points at a Facebook post/permalink (any fb host form). */
export function isFacebookUrl(url: string): boolean {
  return /(?:^|\/\/)(?:[a-z0-9-]+\.)?(?:facebook\.com|fb\.com|fb\.watch|m\.facebook\.com)\//i.test(url);
}

/**
 * Lightly normalize a Facebook post URL. Facebook permalinks come in many shapes
 * (`/permalink.php?story_fbid=…`, `/<page>/posts/<id>`, `/groups/<id>/permalink/<id>`,
 * `fb.watch/<id>`) and there's no single canonical id we can reliably extract,
 * so we keep the URL intact (trimmed, fragment stripped) and let the Apify
 * Facebook comments actor resolve it. Returns null only for clearly non-FB URLs.
 */
export function parseFacebookPostUrl(url: string): { normalizedUrl: string } | null {
  const trimmed = url.trim();
  if (!isFacebookUrl(trimmed)) return null;
  const noFragment = trimmed.split("#")[0];
  return { normalizedUrl: noFragment };
}

/** Build the Apify input for scraping comments from a single Facebook post URL. */
export function buildFacebookCommentCrawlInput(postUrl: string): Record<string, unknown> {
  return {
    startUrls: [{ url: postUrl }],
    resultsLimit: COMMENT_CRAWL_LIMIT,
    includeNestedComments: true,
    viewOption: "RANKED_UNFILTERED",
  };
}

/**
 * Upsert a Facebook user keyed by their profile id (stable across name changes).
 * Mirrors `upsertUser` for Reddit but increments the matching counter and keeps
 * the most recently seen display name / profile URL.
 */
export async function upsertFacebookUser(
  profileId: string,
  displayName: string,
  kind: "post" | "comment",
  profileUrl?: string | null,
) {
  await db
    .insert(facebookUsersTable)
    .values({
      profileId,
      displayName,
      profileUrl: profileUrl ?? null,
      firstSeen: new Date(),
      lastSeen: new Date(),
      totalPosts: kind === "post" ? 1 : 0,
      totalComments: kind === "comment" ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: facebookUsersTable.profileId,
      set: {
        displayName,
        ...(profileUrl ? { profileUrl } : {}),
        lastSeen: new Date(),
        ...(kind === "post"
          ? { totalPosts: sql`${facebookUsersTable.totalPosts} + 1` }
          : { totalComments: sql`${facebookUsersTable.totalComments} + 1` }),
      },
    });
}

/** True if the URL points at an Instagram post/reel/tv permalink. */
export function isInstagramUrl(url: string): boolean {
  return /(?:^|\/\/)(?:[a-z0-9-]+\.)?instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\//i.test(url);
}

/**
 * Parse an Instagram post/reel/tv URL and extract its shortcode. Instagram media
 * URLs are `instagram.com/p/<shortcode>/`, `/reel/<shortcode>/`, `/reels/<…>/`,
 * or `/tv/<shortcode>/` (optionally prefixed by a username). Returns a
 * normalized canonical URL the Apify Instagram comment actor understands.
 */
export function parseInstagramPostUrl(
  url: string,
): { shortcode: string; normalizedUrl: string } | null {
  const trimmed = url.trim();
  if (!isInstagramUrl(trimmed)) return null;
  const m = trimmed.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (!m) return null;
  const shortcode = m[1];
  return { shortcode, normalizedUrl: `https://www.instagram.com/p/${shortcode}/` };
}

/** Build the Apify input for scraping comments from a single Instagram post URL. */
export function buildInstagramCommentCrawlInput(postUrl: string): Record<string, unknown> {
  return {
    directUrls: [postUrl],
    resultsLimit: COMMENT_CRAWL_LIMIT,
    includeNestedComments: true,
  };
}

/**
 * Upsert an Instagram user keyed by their (stable, public) username. Mirrors
 * `upsertFacebookUser` but uses the username as the identity and keeps the most
 * recently seen display name / profile URL.
 */
export async function upsertInstagramUser(
  username: string,
  displayName: string,
  kind: "post" | "comment",
  profileUrl?: string | null,
) {
  await db
    .insert(instagramUsersTable)
    .values({
      username,
      displayName,
      profileUrl: profileUrl ?? null,
      firstSeen: new Date(),
      lastSeen: new Date(),
      totalPosts: kind === "post" ? 1 : 0,
      totalComments: kind === "comment" ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: instagramUsersTable.username,
      set: {
        displayName,
        ...(profileUrl ? { profileUrl } : {}),
        lastSeen: new Date(),
        ...(kind === "post"
          ? { totalPosts: sql`${instagramUsersTable.totalPosts} + 1` }
          : { totalComments: sql`${instagramUsersTable.totalComments} + 1` }),
      },
    });
}

/**
 * True if the URL points at a TikTok post permalink (`/@user/video/<id>` or
 * `/photo/<id>`) or a known short link (`vm./vt.tiktok.com/<code>`,
 * `tiktok.com/t/<code>`). Non-post paths (profiles, `/foryou`, etc.) are
 * rejected so they don't get sent to Apify as invalid crawl targets.
 */
export function isTikTokUrl(url: string): boolean {
  const u = url.trim();
  return (
    /(?:^|\/\/)(?:[a-z0-9-]+\.)?tiktok\.com\/(?:@[\w.-]+\/)?(?:video|photo)\/\d+/i.test(u) ||
    /(?:^|\/\/)(?:vm|vt)\.tiktok\.com\/[A-Za-z0-9]+/i.test(u) ||
    /(?:^|\/\/)(?:[a-z0-9-]+\.)?tiktok\.com\/t\/[A-Za-z0-9]+/i.test(u)
  );
}

/**
 * Parse a TikTok post URL and extract a stable identifier. Full URLs look like
 * `tiktok.com/@user/video/<id>` (or `/photo/<id>`); short links are
 * `vm./vt.tiktok.com/<code>` or `tiktok.com/t/<code>`. The video id (or short
 * code) is used for dedup; the original URL is passed through to the Apify actor,
 * which resolves short links itself.
 */
export function parseTikTokPostUrl(
  url: string,
): { shortcode: string; normalizedUrl: string } | null {
  const trimmed = url.trim();
  if (!isTikTokUrl(trimmed)) return null;
  const videoMatch = trimmed.match(/\/(?:video|photo)\/(\d+)/i);
  if (videoMatch) return { shortcode: videoMatch[1], normalizedUrl: trimmed };
  const shortMatch = trimmed.match(/(?:vm|vt)\.tiktok\.com\/([A-Za-z0-9]+)|tiktok\.com\/t\/([A-Za-z0-9]+)/i);
  if (!shortMatch) return null;
  const shortcode = shortMatch[1] ?? shortMatch[2];
  return { shortcode, normalizedUrl: trimmed };
}

/** Build the Apify input for scraping comments from a single TikTok post URL. */
export function buildTikTokCommentCrawlInput(postUrl: string): Record<string, unknown> {
  return {
    postURLs: [postUrl],
    commentsPerPost: COMMENT_CRAWL_LIMIT,
    maxRepliesPerComment: 10,
  };
}

/**
 * Upsert a TikTok user keyed by their (stable, public) username. Mirrors
 * `upsertInstagramUser` but writes to the TikTok user table.
 */
export async function upsertTikTokUser(
  username: string,
  displayName: string,
  kind: "post" | "comment",
  profileUrl?: string | null,
) {
  await db
    .insert(tiktokUsersTable)
    .values({
      username,
      displayName,
      profileUrl: profileUrl ?? null,
      firstSeen: new Date(),
      lastSeen: new Date(),
      totalPosts: kind === "post" ? 1 : 0,
      totalComments: kind === "comment" ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: tiktokUsersTable.username,
      set: {
        displayName,
        ...(profileUrl ? { profileUrl } : {}),
        lastSeen: new Date(),
        ...(kind === "post"
          ? { totalPosts: sql`${tiktokUsersTable.totalPosts} + 1` }
          : { totalComments: sql`${tiktokUsersTable.totalComments} + 1` }),
      },
    });
}

/**
 * True if the URL points at a Twitter/X status (tweet) permalink, i.e.
 * `(x|twitter).com/<user>/status/<id>`. Profile and other paths are rejected so
 * they don't get sent to Apify as invalid crawl targets.
 */
export function isTwitterUrl(url: string): boolean {
  return /(?:^|\/\/)(?:[a-z0-9-]+\.)?(?:x|twitter)\.com\/(?:[^/]+\/)?status\/\d+/i.test(url.trim());
}

/**
 * Parse a Twitter/X status URL and extract the tweet id. The
 * `kaitoeasyapi~twitter-reply` actor is keyed on the tweet (conversation) id,
 * so the id is the unit of dedup; a canonical `https://x.com/i/status/<id>` URL
 * is returned so `buildTwitterCommentCrawlInput` can recover the id later.
 */
export function parseTwitterPostUrl(
  url: string,
): { shortcode: string; normalizedUrl: string } | null {
  const trimmed = url.trim();
  if (!isTwitterUrl(trimmed)) return null;
  const m = trimmed.match(/status\/(\d+)/i);
  if (!m) return null;
  const tweetId = m[1];
  return { shortcode: tweetId, normalizedUrl: `https://x.com/i/status/${tweetId}` };
}

/**
 * Build the Apify input for scraping replies from a single tweet. The
 * `kaitoeasyapi~twitter-reply` actor takes tweet ids in `conversation_ids` and a
 * per-conversation cap in `max_items_per_conversation`.
 */
export function buildTwitterCommentCrawlInput(postUrl: string): Record<string, unknown> {
  const tweetId = postUrl.match(/status\/(\d+)/i)?.[1] ?? postUrl;
  return {
    conversation_ids: [tweetId],
    max_items_per_conversation: COMMENT_CRAWL_LIMIT,
  };
}

/**
 * Upsert a Twitter user keyed by their (stable, public) username. Mirrors
 * `upsertInstagramUser` but writes to the Twitter user table.
 */
export async function upsertTwitterUser(
  username: string,
  displayName: string,
  kind: "post" | "comment",
  profileUrl?: string | null,
) {
  await db
    .insert(twitterUsersTable)
    .values({
      username,
      displayName,
      profileUrl: profileUrl ?? null,
      firstSeen: new Date(),
      lastSeen: new Date(),
      totalPosts: kind === "post" ? 1 : 0,
      totalComments: kind === "comment" ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: twitterUsersTable.username,
      set: {
        displayName,
        ...(profileUrl ? { profileUrl } : {}),
        lastSeen: new Date(),
        ...(kind === "post"
          ? { totalPosts: sql`${twitterUsersTable.totalPosts} + 1` }
          : { totalComments: sql`${twitterUsersTable.totalComments} + 1` }),
      },
    });
}

/**
 * True if the URL points at a YouTube video (watch page, short link, or Short),
 * i.e. `youtube.com/watch?v=<id>`, `youtu.be/<id>`, or `youtube.com/shorts/<id>`.
 * Channel and other paths are rejected so they aren't sent to Apify as invalid
 * crawl targets.
 */
export function isYoutubeUrl(url: string): boolean {
  const u = url.trim();
  return (
    /(?:^|\/\/)(?:[a-z0-9-]+\.)?youtube\.com\/watch\?(?:[^ ]*&)?v=[\w-]+/i.test(u) ||
    /(?:^|\/\/)(?:[a-z0-9-]+\.)?youtube\.com\/shorts\/[\w-]+/i.test(u) ||
    /(?:^|\/\/)youtu\.be\/[\w-]+/i.test(u)
  );
}

/**
 * Parse a YouTube video URL and extract the video id. The id is the unit of
 * dedup; a canonical `https://www.youtube.com/watch?v=<id>` URL is returned so
 * the comment scraper always receives a stable watch URL regardless of whether
 * the input was a short link or a Short.
 */
export function parseYoutubePostUrl(
  url: string,
): { shortcode: string; normalizedUrl: string } | null {
  const trimmed = url.trim();
  if (!isYoutubeUrl(trimmed)) return null;
  const watchMatch = trimmed.match(/[?&]v=([\w-]+)/i);
  const shortsMatch = trimmed.match(/shorts\/([\w-]+)/i);
  const shortLinkMatch = trimmed.match(/youtu\.be\/([\w-]+)/i);
  const videoId = watchMatch?.[1] ?? shortsMatch?.[1] ?? shortLinkMatch?.[1];
  if (!videoId) return null;
  return { shortcode: videoId, normalizedUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

/**
 * Build the Apify input for scraping comments from a single YouTube video. The
 * `streamers~youtube-comments-scraper` actor takes video URLs in `startUrls` and
 * a per-video cap in `maxComments`. Field names are best-effort for that actor.
 */
export function buildYoutubeCommentCrawlInput(postUrl: string): Record<string, unknown> {
  return {
    startUrls: [{ url: postUrl }],
    maxComments: COMMENT_CRAWL_LIMIT,
  };
}

/**
 * Upsert a YouTube user keyed by their (stable, public) username/channel handle.
 * Mirrors `upsertTwitterUser` but writes to the YouTube user table.
 */
export async function upsertYoutubeUser(
  username: string,
  displayName: string,
  kind: "post" | "comment",
  profileUrl?: string | null,
) {
  await db
    .insert(youtubeUsersTable)
    .values({
      username,
      displayName,
      profileUrl: profileUrl ?? null,
      firstSeen: new Date(),
      lastSeen: new Date(),
      totalPosts: kind === "post" ? 1 : 0,
      totalComments: kind === "comment" ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: youtubeUsersTable.username,
      set: {
        displayName,
        ...(profileUrl ? { profileUrl } : {}),
        lastSeen: new Date(),
        ...(kind === "post"
          ? { totalPosts: sql`${youtubeUsersTable.totalPosts} + 1` }
          : { totalComments: sql`${youtubeUsersTable.totalComments} + 1` }),
      },
    });
}
