import { Router, type IRouter } from "express";
import {
  db,
  topicAnalysesTable,
  topicAnalysisPostsTable,
  postsTable,
  commentsTable,
  facebookCommentsTable,
  instagramCommentsTable,
  tiktokCommentsTable,
  twitterCommentsTable,
  youtubeCommentsTable,
  type TopicAnalysisResult,
} from "@workspace/db";
import { eq, desc, and, notInArray, count, isNull } from "drizzle-orm";
import { CreateTopicAnalysisBody, GetTopicAnalysisParams, IngestRunTopicAnalysisBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { analyzeTopicComments, type TopicCommentInput } from "../lib/analysis";
import {
  getSetting,
  SETTING_APIFY_TOKEN,
  SETTING_APIFY_ACTOR_ID,
  SETTING_APIFY_FACEBOOK_ACTOR_ID,
  SETTING_APIFY_INSTAGRAM_ACTOR_ID,
  SETTING_APIFY_TIKTOK_ACTOR_ID,
  SETTING_APIFY_TWITTER_ACTOR_ID,
  SETTING_APIFY_YOUTUBE_ACTOR_ID,
  DEFAULT_APIFY_ACTOR_ID,
  DEFAULT_FACEBOOK_ACTOR_ID,
  DEFAULT_INSTAGRAM_ACTOR_ID,
  DEFAULT_TIKTOK_ACTOR_ID,
  DEFAULT_TWITTER_ACTOR_ID,
  DEFAULT_YOUTUBE_ACTOR_ID,
  isArcticFallbackEnabled,
} from "../lib/settings";
import { withCostContext } from "../lib/cost-context";
import {
  runApifyActor,
  fetchApifyRunItems,
  pickStr,
  pickNum,
  parseDate,
  buildYoutubeCommentUrl,
  upsertUser,
  parseRedditPostUrl,
  findOrCreateSubreddit,
  buildCommentCrawlInput,
  isFacebookUrl,
  parseFacebookPostUrl,
  buildFacebookCommentCrawlInput,
  upsertFacebookUser,
  isInstagramUrl,
  parseInstagramPostUrl,
  buildInstagramCommentCrawlInput,
  upsertInstagramUser,
  isTikTokUrl,
  parseTikTokPostUrl,
  buildTikTokCommentCrawlInput,
  upsertTikTokUser,
  isTwitterUrl,
  parseTwitterPostUrl,
  buildTwitterCommentCrawlInput,
  upsertTwitterUser,
  isYoutubeUrl,
  parseYoutubePostUrl,
  buildYoutubeCommentCrawlInput,
  upsertYoutubeUser,
  isRemovedBody,
  recoverRemovedBodies,
  isCommentPermalink,
} from "../lib/crawl";
import { classifyUnanalyzedFacebookUsers } from "../lib/facebook-classify";
import { classifyUnanalyzedInstagramUsers } from "../lib/instagram-classify";
import { classifyUnanalyzedTikTokUsers } from "../lib/tiktok-classify";
import { classifyUnanalyzedTwitterUsers } from "../lib/twitter-classify";
import { classifyUnanalyzedYoutubeUsers } from "../lib/youtube-classify";

const router: IRouter = Router();

const MAX_URLS = 20;

// Reports created before the `created_by` column existed have a null creator.
// They all predate multi-account auth, when the sole operator was the main
// admin, so attribute them to that account. Idempotent: only touches null rows,
// and new reports always record their creator, so this is effectively a no-op
// after the first run in each environment (dev now, prod on first publish).
const LEGACY_REPORT_AUTHOR = "legacy-import";

export async function backfillLegacyReportAuthors(): Promise<void> {
  const updated = await db
    .update(topicAnalysesTable)
    .set({ createdBy: LEGACY_REPORT_AUTHOR })
    .where(isNull(topicAnalysesTable.createdBy))
    .returning({ id: topicAnalysesTable.id });
  if (updated.length > 0) {
    logger.info(
      { count: updated.length, author: LEGACY_REPORT_AUTHOR },
      "Backfilled creator for legacy topic analyses",
    );
  }
}

function serializeSummary(row: typeof topicAnalysesTable.$inferSelect) {
  return {
    id: row.id,
    topicSummary: row.topicSummary,
    status: row.status,
    createdBy: row.createdBy ?? null,
    inputUrls: row.inputUrls ?? [],
    themeHints: row.themeHints ?? [],
    themeCount: row.themeCount ?? null,
    postCount: row.postCount,
    commentCount: row.commentCount,
    threadsTotal: row.threadsTotal,
    threadsDone: row.threadsDone,
    commentsGathered: row.commentsGathered,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

router.get("/topic-analyses", async (_req, res): Promise<void> => {
  const rows = await db.select().from(topicAnalysesTable).orderBy(desc(topicAnalysesTable.createdAt));
  res.json(rows.map(serializeSummary));
});

router.get("/topic-analyses/:id", async (req, res): Promise<void> => {
  const params = GetTopicAnalysisParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db.select().from(topicAnalysesTable).where(eq(topicAnalysesTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Topic analysis not found" });
    return;
  }

  const posts = await db
    .select()
    .from(topicAnalysisPostsTable)
    .where(eq(topicAnalysisPostsTable.analysisId, row.id));

  const gathered = row.gatheredComments ?? [];
  res.json({
    ...serializeSummary(row),
    result: row.result ?? null,
    posts: posts.map((p) => ({
      url: p.url,
      title: p.title ?? null,
      commentCount: p.commentCount,
      score: p.score,
    })),
    gatheredComments: gathered.map((c) => ({
      author: c.author,
      body: c.body,
      permalink: c.permalink,
      score: c.score,
      commentKey: c.commentKey ?? null,
    })),
  });
});

router.post("/topic-analyses", async (req, res): Promise<void> => {
  const parsed = CreateTopicAnalysisBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const topicSummary = parsed.data.topicSummary.trim();
  if (!topicSummary) {
    res.status(400).json({ error: "A topic summary is required." });
    return;
  }

  // Normalize, validate and de-duplicate the submitted URLs. Both Reddit and
  // Facebook post URLs are accepted; each is routed to the matching platform's
  // Apify actor and tables at crawl time.
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of parsed.data.urls) {
    const trimmed = raw.trim();
    const fb = parseFacebookPostUrl(trimmed);
    const ig = fb ? null : parseInstagramPostUrl(trimmed);
    const tt = fb || ig ? null : parseTikTokPostUrl(trimmed);
    const tw = fb || ig || tt ? null : parseTwitterPostUrl(trimmed);
    const yt = fb || ig || tt || tw ? null : parseYoutubePostUrl(trimmed);
    const reddit = fb || ig || tt || tw || yt ? null : parseRedditPostUrl(trimmed);
    const normalizedUrl =
      fb?.normalizedUrl ?? ig?.normalizedUrl ?? tt?.normalizedUrl ?? tw?.normalizedUrl ?? yt?.normalizedUrl ?? reddit?.normalizedUrl;
    if (!normalizedUrl) {
      res.status(400).json({
        error: `Invalid post URL: "${raw}". Expected a Reddit thread (https://www.reddit.com/r/<sub>/comments/<id>/…), a Facebook post link, an Instagram post/reel link, a TikTok video link, a Twitter/X post link, or a YouTube video link.`,
      });
      return;
    }
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    urls.push(normalizedUrl);
  }

  if (urls.length === 0) {
    res.status(400).json({ error: "Provide at least one Reddit, Facebook, Instagram, TikTok, Twitter/X, or YouTube post URL." });
    return;
  }
  if (urls.length > MAX_URLS) {
    res.status(400).json({ error: `At most ${MAX_URLS} post URLs are allowed.` });
    return;
  }

  // Optional analyst steering: themes to look for and a desired theme count.
  // Both default to "automatic" when absent so existing behaviour is preserved.
  const themeHints = (parsed.data.themeHints ?? [])
    .map((h) => h.trim())
    .filter(Boolean);
  const themeCount =
    parsed.data.themeCount != null ? parsed.data.themeCount : null;

  const [row] = await db
    .insert(topicAnalysesTable)
    .values({ topicSummary, status: "pending", inputUrls: urls, themeHints, themeCount, createdBy: req.session.user ?? null })
    .returning();

  withCostContext({ appUser: req.session.user ?? null, category: "topic_analysis" }, () =>
    runTopicAnalysis(row.id, topicSummary, urls, { themeHints, themeCount }),
  ).catch((err) => {
    logger.error({ err, analysisId: row.id }, "Topic analysis run failed to start");
  });

  res.status(202).json(serializeSummary(row));
});

router.post("/topic-analyses/:id/reanalyze", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid analysis id." });
    return;
  }

  const [row] = await db.select().from(topicAnalysesTable).where(eq(topicAnalysesTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Topic analysis not found." });
    return;
  }

  const pool = row.gatheredComments ?? [];
  if (pool.length === 0) {
    res.status(400).json({
      error:
        "No stored comments to resume from — this run gathered none or predates comment retention. Re-run it to crawl again.",
    });
    return;
  }

  // Optional: drop the analyst's previously keyed-in steering (theme hints +
  // theme count) and re-group fully automatically. Still zero credits / no crawl.
  const clearSteering = req.body?.clearSteering === true;

  // Atomically claim the run: only transition to "running" when it isn't already
  // pending/running. If no row is updated, a concurrent request beat us to it.
  const [armed] = await db
    .update(topicAnalysesTable)
    .set({
      status: "running",
      errorMessage: null,
      completedAt: null,
      ...(clearSteering ? { themeHints: [], themeCount: null } : {}),
    })
    .where(
      and(
        eq(topicAnalysesTable.id, id),
        notInArray(topicAnalysesTable.status, ["pending", "running"]),
      ),
    )
    .returning();
  if (!armed) {
    res.status(409).json({ error: "This analysis is already in progress." });
    return;
  }

  withCostContext({ appUser: armed.createdBy ?? null, category: "topic_analysis" }, () =>
    reanalyzeTopic(armed.id, armed.topicSummary, pool, {
      themeHints: armed.themeHints ?? [],
      themeCount: armed.themeCount ?? null,
    }),
  ).catch((err) => {
    logger.error({ err, analysisId: armed.id }, "Topic re-analysis failed to start");
  });

  res.status(202).json(serializeSummary(armed));
});

router.post("/topic-analyses/:id/crawl-missing", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid analysis id." });
    return;
  }

  const [row] = await db.select().from(topicAnalysesTable).where(eq(topicAnalysesTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Topic analysis not found." });
    return;
  }

  const inputUrls = row.inputUrls ?? [];
  // A URL that already produced a post row was crawled successfully; everything
  // else in the input list was skipped (failed crawl) and can be re-crawled.
  const existingPosts = await db
    .select({ url: topicAnalysisPostsTable.url })
    .from(topicAnalysisPostsTable)
    .where(eq(topicAnalysisPostsTable.analysisId, id));
  const doneUrls = new Set(existingPosts.map((p) => p.url));
  const missingUrls = inputUrls.filter((u) => !doneUrls.has(u));
  if (missingUrls.length === 0) {
    res.status(400).json({
      error:
        "No skipped links to crawl — every URL already has comments. Use “Re-run with same settings” to re-crawl, or resume to regroup.",
    });
    return;
  }

  // Seed the resume pool with the comments already gathered on this run so the
  // successful links aren't re-crawled (and aren't re-billed on Apify).
  const seedComments: GatheredComment[] = (row.gatheredComments ?? []).map((c, i) => ({
    author: c.author,
    body: c.body,
    permalink: c.permalink,
    score: c.score,
    commentKey: c.commentKey ?? `seed:${i}:${c.permalink}`,
  }));

  // Atomically claim the run (same guard as reanalyze) to avoid double execution.
  const [armed] = await db
    .update(topicAnalysesTable)
    .set({ status: "running", errorMessage: null, completedAt: null })
    .where(
      and(
        eq(topicAnalysesTable.id, id),
        notInArray(topicAnalysesTable.status, ["pending", "running"]),
      ),
    )
    .returning();
  if (!armed) {
    res.status(409).json({ error: "This analysis is already in progress." });
    return;
  }

  withCostContext({ appUser: armed.createdBy ?? null, category: "topic_analysis" }, () =>
    runTopicAnalysis(
      armed.id,
      armed.topicSummary,
      inputUrls,
      { themeHints: armed.themeHints ?? [], themeCount: armed.themeCount ?? null },
      { seedComments, crawlUrls: new Set(missingUrls) },
    ),
  ).catch((err) => {
    logger.error({ err, analysisId: armed.id }, "Topic crawl-missing failed to start");
  });

  res.status(202).json(serializeSummary(armed));
});

/**
 * Re-ingest a single URL from an already-completed (and already-paid) Apify run
 * instead of starting a fresh crawl. Fetching a run's dataset is free, so this
 * lets the user recover a thread whose crawl failed (e.g. a mapping bug) without
 * being re-billed for the actor run. The URL must be one of the analysis's input
 * URLs and must not already have a post row (i.e. it was skipped).
 */
router.post("/topic-analyses/:id/ingest-run", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid analysis id." });
    return;
  }

  const parsed = IngestRunTopicAnalysisBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
    return;
  }
  const { url, runId } = parsed.data;

  const [row] = await db.select().from(topicAnalysesTable).where(eq(topicAnalysesTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Topic analysis not found." });
    return;
  }

  const inputUrls = row.inputUrls ?? [];
  if (!inputUrls.includes(url)) {
    res.status(400).json({ error: "That URL is not one of this analysis's input links." });
    return;
  }

  // A URL is ingestable when it gathered no comments yet — either it has no post
  // row, or it has a post row with 0 comments (a crawl that ran but ingested
  // nothing, e.g. the Twitter mapping bug). A URL that already has comments must
  // use "Re-run with same settings" instead.
  const existingPosts = await db
    .select({ url: topicAnalysisPostsTable.url, commentCount: topicAnalysisPostsTable.commentCount })
    .from(topicAnalysisPostsTable)
    .where(eq(topicAnalysisPostsTable.analysisId, id));
  const urlCommentTotal = existingPosts
    .filter((p) => p.url === url)
    .reduce((sum, p) => sum + p.commentCount, 0);
  if (urlCommentTotal > 0) {
    res.status(400).json({
      error: "That URL already has comments. Use “Re-run with same settings” to re-crawl it.",
    });
    return;
  }

  const token = await getSetting(SETTING_APIFY_TOKEN);
  if (!token) {
    res.status(400).json({ error: "Apify token is not configured. Set it in the Admin Panel." });
    return;
  }

  // Free: fetch the existing run's dataset items (no actor run, no re-billing).
  let items: Array<Record<string, unknown>>;
  try {
    items = await fetchApifyRunItems(token, runId);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const seedComments: GatheredComment[] = (row.gatheredComments ?? []).map((c, i) => ({
    author: c.author,
    body: c.body,
    permalink: c.permalink,
    score: c.score,
    commentKey: c.commentKey ?? `seed:${i}:${c.permalink}`,
  }));

  const [armed] = await db
    .update(topicAnalysesTable)
    .set({ status: "running", errorMessage: null, completedAt: null })
    .where(
      and(
        eq(topicAnalysesTable.id, id),
        notInArray(topicAnalysesTable.status, ["pending", "running"]),
      ),
    )
    .returning();
  if (!armed) {
    res.status(409).json({ error: "This analysis is already in progress." });
    return;
  }

  // Remove the stale 0-comment post row for this URL (if any) so the re-ingest
  // produces a single, correct post row instead of a duplicate (there's no
  // unique constraint on analysis_id+url).
  await db
    .delete(topicAnalysisPostsTable)
    .where(and(eq(topicAnalysisPostsTable.analysisId, id), eq(topicAnalysisPostsTable.url, url)));

  withCostContext({ appUser: armed.createdBy ?? null, category: "topic_analysis" }, () =>
    runTopicAnalysis(
      armed.id,
      armed.topicSummary,
      inputUrls,
      { themeHints: armed.themeHints ?? [], themeCount: armed.themeCount ?? null },
      {
        seedComments,
        crawlUrls: new Set([url]),
        prefetched: new Map([[url, items]]),
      },
    ),
  ).catch((err) => {
    logger.error({ err, analysisId: armed.id }, "Topic ingest-run failed to start");
  });

  res.status(202).json(serializeSummary(armed));
});

router.delete("/topic-analyses/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid analysis id." });
    return;
  }

  // topic_analysis_posts rows cascade via their FK ON DELETE CASCADE.
  const deleted = await db
    .delete(topicAnalysesTable)
    .where(eq(topicAnalysesTable.id, id))
    .returning({ id: topicAnalysesTable.id });

  if (deleted.length === 0) {
    res.status(404).json({ error: "Topic analysis not found." });
    return;
  }

  res.status(204).end();
});

/**
 * Re-run only the AI grouping step against a run's already-gathered comment pool
 * — no Apify re-crawl. Used to cheaply recover failed reports.
 */
async function reanalyzeTopic(
  analysisId: number,
  topicSummary: string,
  comments: TopicCommentInput[],
  options: { themeHints: string[]; themeCount: number | null },
): Promise<void> {
  try {
    const ai = await analyzeTopicComments(topicSummary, comments, {
      themeHints: options.themeHints,
      themeCount: options.themeCount,
    });
    const result: TopicAnalysisResult = {
      executiveSummary: ai.executiveSummary,
      themes: ai.themes,
      flagged: ai.flagged,
      otherComments: ai.otherComments ?? [],
    };
    // Derive postCount from the persisted per-post rows so a run that failed
    // before its original completion write (postCount left at 0) is corrected.
    const [postCountRow] = await db
      .select({ value: count() })
      .from(topicAnalysisPostsTable)
      .where(eq(topicAnalysisPostsTable.analysisId, analysisId));
    const postCount = Number(postCountRow?.value ?? 0);
    await db
      .update(topicAnalysesTable)
      .set({
        status: "completed",
        result,
        postCount,
        commentCount: comments.length,
        errorMessage: null,
        completedAt: new Date(),
      })
      .where(eq(topicAnalysesTable.id, analysisId));
    logger.info({ analysisId, postCount, comments: comments.length }, "Topic re-analysis completed");
  } catch (err) {
    logger.error({ err, analysisId }, "Topic re-analysis failed");
    await db
      .update(topicAnalysesTable)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(topicAnalysesTable.id, analysisId));
  }
}

/** Reddit permalink to a specific comment within its thread. */
function commentPermalink(subreddit: string, postId: string, commentId: string): string {
  return `https://www.reddit.com/r/${subreddit}/comments/${postId}/comment/${commentId}/`;
}

interface GatheredComment extends TopicCommentInput {
  /** Platform-prefixed unique key (e.g. `reddit:<id>` / `facebook:<id>`) for cross-thread dedup. */
  commentKey: string;
}

/**
 * Crawl each submitted thread's comments (sequentially — one Apify run per URL),
 * persist posts and comments, record per-post counts, then run the AI grouping
 * and store the final report. Designed to run detached in the background.
 */
async function runTopicAnalysis(
  analysisId: number,
  topicSummary: string,
  urls: string[],
  options: { themeHints: string[]; themeCount: number | null },
  // Optional "crawl only the skipped links" mode: seed the analysis pool with
  // comments already gathered on a prior run and crawl only `crawlUrls`, so the
  // user doesn't re-pay Apify for links that already succeeded. `prefetched` maps
  // a URL to dataset items already fetched from an existing Apify run (free), so
  // that URL is ingested from those items instead of starting a fresh crawl.
  resume?: {
    seedComments: GatheredComment[];
    crawlUrls: Set<string>;
    prefetched?: Map<string, Array<Record<string, unknown>>>;
  },
) {
  try {
    await db
      .update(topicAnalysesTable)
      .set({
        status: "running",
        threadsTotal: resume ? resume.crawlUrls.size : urls.length,
        threadsDone: 0,
        commentsGathered: 0,
      })
      .where(eq(topicAnalysesTable.id, analysisId));

    const token = await getSetting(SETTING_APIFY_TOKEN);
    if (!token) {
      throw new Error("Apify API key not configured. Add it in the Admin Panel to enable crawling.");
    }
    const actorId = (await getSetting(SETTING_APIFY_ACTOR_ID)) ?? DEFAULT_APIFY_ACTOR_ID;
    const facebookActorId = (await getSetting(SETTING_APIFY_FACEBOOK_ACTOR_ID)) ?? DEFAULT_FACEBOOK_ACTOR_ID;
    const instagramActorId = (await getSetting(SETTING_APIFY_INSTAGRAM_ACTOR_ID)) ?? DEFAULT_INSTAGRAM_ACTOR_ID;
    const tiktokActorId = (await getSetting(SETTING_APIFY_TIKTOK_ACTOR_ID)) ?? DEFAULT_TIKTOK_ACTOR_ID;
    const twitterActorId = (await getSetting(SETTING_APIFY_TWITTER_ACTOR_ID)) ?? DEFAULT_TWITTER_ACTOR_ID;
    const youtubeActorId = (await getSetting(SETTING_APIFY_YOUTUBE_ACTOR_ID)) ?? DEFAULT_YOUTUBE_ACTOR_ID;

    // Fetch the dataset items for a URL: reuse already-fetched items from an
    // existing Apify run when provided (free re-ingest), otherwise start a fresh
    // crawl. Returns null on failure so the caller can skip the URL.
    const loadItems = async (
      platform: string,
      url: string,
      actorId: string,
      input: Record<string, unknown>,
    ): Promise<Array<Record<string, unknown>> | null> => {
      const pre = resume?.prefetched?.get(url);
      if (pre) {
        logger.info({ analysisId, url, platform, count: pre.length }, "Topic ingest using existing Apify run dataset");
        return pre;
      }
      try {
        return await runApifyActor(token, actorId, input, async (status) => {
          logger.info({ analysisId, url, status }, `Topic crawl Apify status (${platform})`);
        });
      } catch (err) {
        logger.error({ err, analysisId, url }, `Topic crawl failed for ${platform} URL; skipping`);
        return null;
      }
    };

    const allComments: GatheredComment[] = resume ? [...resume.seedComments] : [];
    let totalNewComments = 0;
    let postsAnalyzed = 0;
    let totalGatheredComments = 0;
    let facebookCommentsIngested = false;
    let instagramCommentsIngested = false;
    let tiktokCommentsIngested = false;
    let twitterCommentsIngested = false;
    let youtubeCommentsIngested = false;

    for (const url of urls) {
      // In "crawl only the skipped links" mode, leave already-crawled URLs alone:
      // their comments are already in the seed pool and their post row exists.
      if (resume && !resume.crawlUrls.has(url)) continue;
      let urlCommentCount = 0;
      // Total reactions/upvotes across this thread's unique comments. The comment
      // actors return per-comment engagement (FB likes, Reddit upvotes) but not the
      // parent post's own reaction count, so we surface aggregate comment engagement.
      let urlCommentScoreSum = 0;

      if (isFacebookUrl(url)) {
        // ---- Facebook thread: route to the FB comment actor + FB tables ----
        const items = await loadItems("facebook", url, facebookActorId, buildFacebookCommentCrawlInput(url));
        if (!items) continue;

        const seenCommentIds = new Set<string>();
        for (const item of items) {
          const authorProfileId = pickStr(item, "profileId", "facebookId", "id");
          const authorName = pickStr(item, "profileName", "name", "authorName");
          const body = pickStr(item, "text", "comment", "message");
          const fbCommentId = pickStr(item, "commentId", "feedbackId") ?? pickStr(item, "id");
          if (!authorProfileId || !body || !fbCommentId) continue;
          const score = pickNum(item, "likesCount", "likes");
          const commentUrl = pickStr(item, "commentUrl");
          const profileUrl = pickStr(item, "profileUrl");

          const inserted = await db
            .insert(facebookCommentsTable)
            .values({
              fbCommentId,
              postId: null,
              authorProfileId,
              authorName: authorName ?? authorProfileId,
              body,
              likes: score,
              commentUrl,
              postedAt: parseDate(pickStr(item, "date", "createdAt", "time")),
            })
            .onConflictDoNothing()
            .returning({ id: facebookCommentsTable.id });
          if (inserted.length > 0) {
            await upsertFacebookUser(authorProfileId, authorName ?? authorProfileId, "comment", profileUrl);
            totalNewComments++;
          }
          allComments.push({
            commentKey: `facebook:${fbCommentId}`,
            author: authorName ?? authorProfileId,
            body,
            score,
            permalink: commentUrl ?? url,
          });
          if (!seenCommentIds.has(fbCommentId)) {
            seenCommentIds.add(fbCommentId);
            urlCommentCount++;
            urlCommentScoreSum += score;
          }
        }

        facebookCommentsIngested = true;
        await db.insert(topicAnalysisPostsTable).values({
          analysisId,
          postId: null,
          url,
          title: null,
          commentCount: urlCommentCount,
          score: urlCommentScoreSum,
        });
      } else if (isInstagramUrl(url)) {
        // ---- Instagram thread: route to the IG comment actor + IG tables ----
        const items = await loadItems("instagram", url, instagramActorId, buildInstagramCommentCrawlInput(url));
        if (!items) continue;

        const seenCommentIds = new Set<string>();
        for (const item of items) {
          const authorUsername = pickStr(item, "ownerUsername", "username", "owner");
          const body = pickStr(item, "text", "comment", "message");
          const igCommentId = pickStr(item, "id", "commentId");
          if (!authorUsername || !body || !igCommentId) continue;
          const score = pickNum(item, "likesCount", "likes");
          const profileUrl = authorUsername ? `https://www.instagram.com/${authorUsername}/` : null;
          const commentUrl = pickStr(item, "commentUrl") ?? url;

          const inserted = await db
            .insert(instagramCommentsTable)
            .values({
              igCommentId,
              postId: null,
              authorUsername,
              authorName: pickStr(item, "ownerName", "name") ?? authorUsername,
              body,
              likes: score,
              commentUrl,
              postedAt: parseDate(pickStr(item, "timestamp", "createdAt", "date")),
            })
            .onConflictDoNothing()
            .returning({ id: instagramCommentsTable.id });
          if (inserted.length > 0) {
            await upsertInstagramUser(authorUsername, pickStr(item, "ownerName", "name") ?? authorUsername, "comment", profileUrl);
            totalNewComments++;
          }
          allComments.push({
            commentKey: `instagram:${igCommentId}`,
            author: authorUsername,
            body,
            score,
            permalink: commentUrl,
          });
          if (!seenCommentIds.has(igCommentId)) {
            seenCommentIds.add(igCommentId);
            urlCommentCount++;
            urlCommentScoreSum += score;
          }
        }

        instagramCommentsIngested = true;
        await db.insert(topicAnalysisPostsTable).values({
          analysisId,
          postId: null,
          url,
          title: null,
          commentCount: urlCommentCount,
          score: urlCommentScoreSum,
        });
      } else if (isTikTokUrl(url)) {
        // ---- TikTok thread: route to the TikTok comment actor + TikTok tables ----
        const items = await loadItems("tiktok", url, tiktokActorId, buildTikTokCommentCrawlInput(url));
        if (!items) continue;

        const seenCommentIds = new Set<string>();
        for (const item of items) {
          const authorUsername = pickStr(item, "uniqueId", "username", "uid");
          const body = pickStr(item, "text", "comment", "message");
          const ttCommentId = pickStr(item, "cid", "id", "commentId");
          if (!authorUsername || !body || !ttCommentId) continue;
          const score = pickNum(item, "diggCount", "likesCount", "likes");
          const profileUrl = authorUsername ? `https://www.tiktok.com/@${authorUsername}` : null;
          const commentUrl = pickStr(item, "commentUrl") ?? url;

          const inserted = await db
            .insert(tiktokCommentsTable)
            .values({
              ttCommentId,
              postId: null,
              authorUsername,
              authorName: pickStr(item, "nickname", "name") ?? authorUsername,
              body,
              likes: score,
              commentUrl,
              postedAt: parseDate(pickStr(item, "createTimeISO", "createTime", "timestamp", "date")),
            })
            .onConflictDoNothing()
            .returning({ id: tiktokCommentsTable.id });
          if (inserted.length > 0) {
            await upsertTikTokUser(authorUsername, pickStr(item, "nickname", "name") ?? authorUsername, "comment", profileUrl);
            totalNewComments++;
          }
          allComments.push({
            commentKey: `tiktok:${ttCommentId}`,
            author: authorUsername,
            body,
            score,
            permalink: commentUrl,
          });
          if (!seenCommentIds.has(ttCommentId)) {
            seenCommentIds.add(ttCommentId);
            urlCommentCount++;
            urlCommentScoreSum += score;
          }
        }

        tiktokCommentsIngested = true;
        await db.insert(topicAnalysisPostsTable).values({
          analysisId,
          postId: null,
          url,
          title: null,
          commentCount: urlCommentCount,
          score: urlCommentScoreSum,
        });
      } else if (isTwitterUrl(url)) {
        // ---- Twitter/X thread: route to the Twitter reply actor + Twitter tables ----
        const items = await loadItems("twitter", url, twitterActorId, buildTwitterCommentCrawlInput(url));
        if (!items) continue;

        const seenCommentIds = new Set<string>();
        for (const item of items) {
          // The reply actor (kaitoeasyapi~twitter-reply) nests the tweet author
          // under an `author` object; other actors expose it top-level. Read both.
          const authorObj =
            item.author && typeof item.author === "object"
              ? (item.author as Record<string, unknown>)
              : null;
          const authorUsername =
            pickStr(item, "username", "userName", "screen_name") ??
            (authorObj ? pickStr(authorObj, "userName", "username", "screenName", "screen_name") : null);
          const authorName =
            pickStr(item, "name", "displayName", "fullName") ??
            (authorObj ? pickStr(authorObj, "name", "displayName", "fullName") : null);
          const body = pickStr(item, "text", "full_text", "comment", "message");
          const twCommentId = pickStr(item, "id", "id_str", "tweet_id", "commentId");
          if (!authorUsername || !body || !twCommentId) continue;
          // The dataset includes the root tweet itself (its id equals the thread's
          // conversationId). Skip it so the post being analysed isn't ingested as
          // one of its own replies.
          const conversationId = pickStr(item, "conversationId", "conversation_id");
          if (conversationId && conversationId === twCommentId) continue;
          const resolvedName = authorName ?? authorUsername;
          const score = pickNum(item, "likeCount", "favorite_count", "likes", "favoriteCount");
          const profileUrl = authorUsername ? `https://x.com/${authorUsername}` : null;
          const commentUrl = pickStr(item, "url", "commentUrl", "twitterUrl") ?? url;

          const inserted = await db
            .insert(twitterCommentsTable)
            .values({
              twCommentId,
              postId: null,
              authorUsername,
              authorName: resolvedName,
              body,
              likes: score,
              commentUrl,
              postedAt: parseDate(pickStr(item, "createdAt", "created_at", "timestamp", "date")),
            })
            .onConflictDoNothing()
            .returning({ id: twitterCommentsTable.id });
          if (inserted.length > 0) {
            await upsertTwitterUser(authorUsername, resolvedName, "comment", profileUrl);
            totalNewComments++;
          }
          allComments.push({
            commentKey: `twitter:${twCommentId}`,
            author: authorUsername,
            body,
            score,
            permalink: commentUrl,
          });
          if (!seenCommentIds.has(twCommentId)) {
            seenCommentIds.add(twCommentId);
            urlCommentCount++;
            urlCommentScoreSum += score;
          }
        }

        twitterCommentsIngested = true;
        await db.insert(topicAnalysisPostsTable).values({
          analysisId,
          postId: null,
          url,
          title: null,
          commentCount: urlCommentCount,
          score: urlCommentScoreSum,
        });
      } else if (isYoutubeUrl(url)) {
        // ---- YouTube video: route to the YouTube comments actor + YouTube tables ----
        const items = await loadItems("youtube", url, youtubeActorId, buildYoutubeCommentCrawlInput(url));
        if (!items) continue;

        const seenCommentIds = new Set<string>();
        for (const item of items) {
          const authorUsername = pickStr(item, "author", "authorName", "channelName", "username", "userName");
          const body = pickStr(item, "comment", "text", "commentText", "message");
          const ytCommentId = pickStr(item, "commentId", "cid", "id", "commentIdString");
          if (!authorUsername || !body || !ytCommentId) continue;
          const score = pickNum(item, "voteCount", "votes", "likes", "likeCount");
          const handle = authorUsername.startsWith("@") ? authorUsername : `@${authorUsername}`;
          const profileUrl = pickStr(item, "authorChannelUrl", "channelUrl", "authorUrl") ?? `https://www.youtube.com/${handle}`;
          const commentUrl =
            buildYoutubeCommentUrl(url, ytCommentId) ?? pickStr(item, "commentUrl", "url") ?? url;

          const inserted = await db
            .insert(youtubeCommentsTable)
            .values({
              ytCommentId,
              postId: null,
              authorUsername,
              authorName: pickStr(item, "authorName", "author", "channelName") ?? authorUsername,
              body,
              likes: score,
              commentUrl,
              postedAt: parseDate(pickStr(item, "publishedTimeText", "publishedAt", "date", "createdAt", "timestamp")),
            })
            .onConflictDoNothing()
            .returning({ id: youtubeCommentsTable.id });
          if (inserted.length > 0) {
            await upsertYoutubeUser(authorUsername, pickStr(item, "authorName", "author", "channelName") ?? authorUsername, "comment", profileUrl);
            totalNewComments++;
          }
          allComments.push({
            commentKey: `youtube:${ytCommentId}`,
            author: authorUsername,
            body,
            score,
            permalink: commentUrl,
          });
          if (!seenCommentIds.has(ytCommentId)) {
            seenCommentIds.add(ytCommentId);
            urlCommentCount++;
            urlCommentScoreSum += score;
          }
        }

        youtubeCommentsIngested = true;
        await db.insert(topicAnalysisPostsTable).values({
          analysisId,
          postId: null,
          url,
          title: null,
          commentCount: urlCommentCount,
          score: urlCommentScoreSum,
        });
      } else {
        // ---- Reddit thread: existing path, unchanged ----
        const meta = parseRedditPostUrl(url);
        if (!meta) continue;
        const sub = await findOrCreateSubreddit(meta.subreddit);

        const items = await loadItems("reddit", url, actorId, buildCommentCrawlInput(url));
        if (!items) continue;

        // Recover deleted/removed bodies from the Arctic Shift archive (toggle,
        // default ON). Apify stays primary; we only heal tombstoned items so the
        // analysis pool sees the real text instead of "[ Removed by Reddit ]".
        let recoveredComments = new Map<string, { body: string; score: number }>();
        let recoveredPosts = new Map<string, { body: string; score: number }>();
        if (await isArcticFallbackEnabled()) {
          const commentIds: string[] = [];
          const postIds: string[] = [];
          for (const item of items) {
            const dataType = pickStr(item, "dataType", "type");
            const isComment = dataType === "comment" || (!item.title && (item.body || item.text) && !dataType);
            if (isComment) {
              const id = pickStr(item, "id", "commentId", "parsedId");
              if (id && isRemovedBody(pickStr(item, "body", "text", "comment"))) commentIds.push(id);
            } else {
              const id = pickStr(item, "id", "postId", "parsedId");
              if (id && isRemovedBody(pickStr(item, "body", "text", "selftext"))) postIds.push(id);
            }
          }
          if (commentIds.length > 0) recoveredComments = await recoverRemovedBodies("comments", commentIds);
          if (postIds.length > 0) recoveredPosts = await recoverRemovedBodies("posts", postIds);
        }

        let postRowId: number | null = null;
        let postTitle: string | null = null;
        let postScore = 0;
        const seenCommentIds = new Set<string>();

        for (const item of items) {
          const dataType = pickStr(item, "dataType", "type");
          const author = pickStr(item, "username", "author", "authorName");
          const isComment = dataType === "comment" || (!item.title && (item.body || item.text) && !dataType);

          if (isComment) {
            if (!author || author === "[deleted]") continue;
            const id = pickStr(item, "id", "commentId", "parsedId");
            const rawBody = pickStr(item, "body", "text", "comment");
            if (!id || !rawBody) continue;
            const rec = isRemovedBody(rawBody) ? recoveredComments.get(id) : undefined;
            const body = rec?.body ?? rawBody;
            const score = rec?.score ?? pickNum(item, "upVotes", "score", "upvotes");
            const rawCommentUrl = pickStr(item, "url", "permalink", "link");
            const permalink = isCommentPermalink(rawCommentUrl)
              ? rawCommentUrl!
              : commentPermalink(meta.subreddit, meta.postId, id);

            const inserted = await db
              .insert(commentsTable)
              .values({
                subredditId: sub.id,
                redditCommentId: id,
                author,
                body,
                score,
                parentId: pickStr(item, "postId", "parentId", "parent_id"),
                permalink,
                postedAt: parseDate(pickStr(item, "createdAt", "created", "createdAtFormatted")),
                recoveredAt: rec ? new Date() : null,
              })
              .onConflictDoNothing()
              .returning({ id: commentsTable.id });
            if (inserted.length > 0) {
              await upsertUser(author, "comment");
              totalNewComments++;
            }
            // Always include the comment in the analysis pool (even if it was a
            // duplicate from a prior crawl) so the report reflects the full thread.
            allComments.push({ commentKey: `reddit:${id}`, author, body, score, permalink });
            // Count each unique comment id once per thread so per-post counts
            // aren't inflated by duplicate items emitted by the scraper.
            if (!seenCommentIds.has(id)) {
              seenCommentIds.add(id);
              urlCommentCount++;
              urlCommentScoreSum += score;
            }
          } else {
            const id = pickStr(item, "id", "postId", "parsedId");
            const title = pickStr(item, "title");
            if (!id || !title) continue;
            postTitle = title;
            postScore = pickNum(item, "upVotes", "score", "upvotes");
            if (author && author !== "[deleted]") {
              const rawPostBody = pickStr(item, "body", "text", "selftext");
              const recPost = isRemovedBody(rawPostBody) ? recoveredPosts.get(id) : undefined;
              const insertedPost = await db
                .insert(postsTable)
                .values({
                  subredditId: sub.id,
                  redditPostId: id,
                  title,
                  body: recPost?.body ?? rawPostBody,
                  author,
                  score: recPost?.score ?? postScore,
                  permalink: pickStr(item, "url", "permalink", "link") ?? url,
                  postedAt: parseDate(pickStr(item, "createdAt", "created", "createdAtFormatted")),
                  recoveredAt: recPost ? new Date() : null,
                })
                .onConflictDoNothing()
                .returning({ id: postsTable.id });
              if (insertedPost.length > 0) {
                await upsertUser(author, "post");
                postRowId = insertedPost[0].id;
              } else {
                const [existingPost] = await db
                  .select({ id: postsTable.id })
                  .from(postsTable)
                  .where(eq(postsTable.redditPostId, id));
                postRowId = existingPost?.id ?? null;
              }
            }
          }
        }

        await db.insert(topicAnalysisPostsTable).values({
          analysisId,
          postId: postRowId,
          url,
          title: postTitle,
          commentCount: urlCommentCount,
          score: urlCommentScoreSum,
        });
      }

      postsAnalyzed++;

      // Record incremental progress so the polling UI can show how far the crawl
      // has got (X of N threads, total comments gathered so far).
      totalGatheredComments += urlCommentCount;
      await db
        .update(topicAnalysesTable)
        .set({ threadsDone: postsAnalyzed, commentsGathered: totalGatheredComments })
        .where(eq(topicAnalysesTable.id, analysisId));
    }

    // Attribute these auto follow-up classification batches to whoever launched
    // the report, so the pipeline queue shows a real user instead of "system".
    const [reportRow] = await db
      .select({ createdBy: topicAnalysesTable.createdBy })
      .from(topicAnalysesTable)
      .where(eq(topicAnalysesTable.id, analysisId));
    const reportLaunchedBy = reportRow?.createdBy ?? null;

    // Classify any newly-ingested Facebook commenters with the same 14 archetypes
    // so they surface in the Facebook section. Detached failures shouldn't fail
    // the topic report.
    if (facebookCommentsIngested) {
      // Neutral cost context: this multi-user batch classification is
      // platform/shared spend (appUser null), NOT the report initiator's cost,
      // even though it runs inside the report's topic_analysis context.
      withCostContext({ appUser: null, category: "batch_classify" }, () =>
        classifyUnanalyzedFacebookUsers(reportLaunchedBy),
      ).catch((err) => {
        logger.error({ err, analysisId }, "Facebook classification after topic crawl failed");
      });
    }

    // Same for newly-ingested Instagram commenters.
    if (instagramCommentsIngested) {
      withCostContext({ appUser: null, category: "batch_classify" }, () =>
        classifyUnanalyzedInstagramUsers(reportLaunchedBy),
      ).catch((err) => {
        logger.error({ err, analysisId }, "Instagram classification after topic crawl failed");
      });
    }

    // Same for newly-ingested TikTok commenters.
    if (tiktokCommentsIngested) {
      withCostContext({ appUser: null, category: "batch_classify" }, () =>
        classifyUnanalyzedTikTokUsers(reportLaunchedBy),
      ).catch((err) => {
        logger.error({ err, analysisId }, "TikTok classification after topic crawl failed");
      });
    }

    // Same for newly-ingested Twitter commenters.
    if (twitterCommentsIngested) {
      withCostContext({ appUser: null, category: "batch_classify" }, () =>
        classifyUnanalyzedTwitterUsers(reportLaunchedBy),
      ).catch((err) => {
        logger.error({ err, analysisId }, "Twitter classification after topic crawl failed");
      });
    }

    // Same for newly-ingested YouTube commenters.
    if (youtubeCommentsIngested) {
      withCostContext({ appUser: null, category: "batch_classify" }, () =>
        classifyUnanalyzedYoutubeUsers(reportLaunchedBy),
      ).catch((err) => {
        logger.error({ err, analysisId }, "YouTube classification after topic crawl failed");
      });
    }

    // De-duplicate the analysis pool across threads (a comment key is globally
    // unique per platform) so repeated crawls don't double-feed the model.
    const uniqueComments = Array.from(
      new Map(allComments.map((c) => [c.commentKey, c])).values(),
    ) as GatheredComment[];

    if (uniqueComments.length === 0) {
      throw new Error(
        "No comments were gathered from the submitted URLs. Check the links — and note that comment scraping requires a comment-capable Apify actor.",
      );
    }

    // Persist the gathered pool before the AI step so a grouping failure can be
    // resumed later without re-crawling Apify.
    await db
      .update(topicAnalysesTable)
      .set({ gatheredComments: uniqueComments })
      .where(eq(topicAnalysesTable.id, analysisId));

    const ai = await analyzeTopicComments(topicSummary, uniqueComments, {
      themeHints: options.themeHints,
      themeCount: options.themeCount,
    });
    const result: TopicAnalysisResult = {
      executiveSummary: ai.executiveSummary,
      themes: ai.themes,
      flagged: ai.flagged,
      otherComments: ai.otherComments ?? [],
    };

    // When resuming, postsAnalyzed only counts the freshly-crawled links; the true
    // post total is every post row on the run (prior successes + new ones).
    let finalPostCount = postsAnalyzed;
    if (resume) {
      const [postRow] = await db
        .select({ value: count() })
        .from(topicAnalysisPostsTable)
        .where(eq(topicAnalysisPostsTable.analysisId, analysisId));
      finalPostCount = Number(postRow?.value ?? postsAnalyzed);
    }

    await db
      .update(topicAnalysesTable)
      .set({
        status: "completed",
        result,
        postCount: finalPostCount,
        commentCount: uniqueComments.length,
        completedAt: new Date(),
      })
      .where(eq(topicAnalysesTable.id, analysisId));

    logger.info(
      { analysisId, postsAnalyzed, comments: uniqueComments.length, newComments: totalNewComments },
      "Topic analysis completed",
    );
  } catch (err) {
    logger.error({ err, analysisId }, "Topic analysis failed");
    await db
      .update(topicAnalysesTable)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(topicAnalysesTable.id, analysisId));
  }
}

export default router;
