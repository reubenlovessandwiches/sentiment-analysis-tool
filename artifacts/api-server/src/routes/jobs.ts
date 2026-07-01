import { Router, type IRouter } from "express";
import {
  db,
  jobsTable,
  subredditsTable,
  redditUsersTable,
  postsTable,
  commentsTable,
  analysesTable,
  archetypeScoresTable,
  topicAnalysesTable,
} from "@workspace/db";
import { eq, desc, sql, and, inArray, isNotNull } from "drizzle-orm";
import { ListJobsQueryParams, StartCrawlBody, CancelJobParams } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { analyzeUserContent } from "../lib/analysis";
import { ARCHETYPES } from "../lib/archetypes";
import { getSetting, SETTING_APIFY_TOKEN, SETTING_APIFY_ACTOR_ID, DEFAULT_APIFY_ACTOR_ID, isArcticFallbackEnabled } from "../lib/settings";
import {
  COMMENT_CRAWL_LIMIT,
  runApifyActor,
  pickStr,
  pickNum,
  parseDate,
  upsertUser,
  parseRedditPostUrl,
  findOrCreateSubreddit,
  isRemovedBody,
  recoverRemovedBodies,
  isCommentPermalink,
} from "../lib/crawl";
import { crawlUserViaArcticShift } from "../lib/user-investigation";
import { analyzeAndPersistUser, findUserIdByUsername, flagUserComments } from "../lib/user-analysis";
import { withCostContext } from "../lib/cost-context";

const router: IRouter = Router();

router.get("/jobs", async (req, res): Promise<void> => {
  const params = ListJobsQueryParams.safeParse(req.query);
  const limit = params.success && params.data.limit != null ? params.data.limit : 20;
  const offset = params.success && params.data.offset != null ? params.data.offset : 0;
  const statusFilter = params.success ? params.data.status : undefined;

  // The pipeline queue is a unified activity log: background jobs (crawls,
  // classification batches) live in `jobs`, while sentiment reports live in the
  // separate `topic_analyses` table. We merge both into one time-sorted list so
  // the admin sees everything that ran — crawls, classification, and report
  // generation — in a single queue. Ids are only unique within a `source`.
  type QueueItem = {
    source: "job" | "sentiment";
    id: number;
    jobType: string;
    title: string | null;
    status: string;
    subredditId: number | null;
    subredditName: string | null;
    targetUsername: string | null;
    postUrl: string | null;
    progress: number | null;
    total: number | null;
    errorMessage: string | null;
    createdAt: Date;
    completedAt: Date | null;
    launchedBy: string | null;
  };

  const jobWhere = statusFilter ? eq(jobsTable.status, statusFilter) : undefined;
  const jobRows = await db
    .select({
      id: jobsTable.id,
      jobType: jobsTable.jobType,
      status: jobsTable.status,
      subredditId: jobsTable.subredditId,
      subredditName: subredditsTable.subredditName,
      targetUsername: jobsTable.targetUsername,
      postUrl: jobsTable.postUrl,
      progress: jobsTable.progress,
      total: jobsTable.total,
      errorMessage: jobsTable.errorMessage,
      createdAt: jobsTable.createdAt,
      completedAt: jobsTable.completedAt,
      createdBy: jobsTable.createdBy,
    })
    .from(jobsTable)
    .leftJoin(subredditsTable, eq(jobsTable.subredditId, subredditsTable.id))
    .where(jobWhere)
    .orderBy(desc(jobsTable.createdAt));

  const reportWhere = statusFilter ? eq(topicAnalysesTable.status, statusFilter) : undefined;
  const reportRows = await db
    .select({
      id: topicAnalysesTable.id,
      topicSummary: topicAnalysesTable.topicSummary,
      status: topicAnalysesTable.status,
      threadsDone: topicAnalysesTable.threadsDone,
      threadsTotal: topicAnalysesTable.threadsTotal,
      errorMessage: topicAnalysesTable.errorMessage,
      createdAt: topicAnalysesTable.createdAt,
      completedAt: topicAnalysesTable.completedAt,
      createdBy: topicAnalysesTable.createdBy,
    })
    .from(topicAnalysesTable)
    .where(reportWhere)
    .orderBy(desc(topicAnalysesTable.createdAt));

  const jobItems: QueueItem[] = jobRows.map((j) => ({
    source: "job",
    id: j.id,
    jobType: j.jobType,
    title: null,
    status: j.status,
    subredditId: j.subredditId ?? null,
    subredditName: j.subredditName ?? null,
    targetUsername: j.targetUsername ?? null,
    postUrl: j.postUrl ?? null,
    progress: j.progress ?? null,
    total: j.total ?? null,
    errorMessage: j.errorMessage ?? null,
    createdAt: j.createdAt,
    completedAt: j.completedAt ?? null,
    launchedBy: j.createdBy ?? null,
  }));

  const reportItems: QueueItem[] = reportRows.map((r) => ({
    source: "sentiment",
    id: r.id,
    jobType: "topic_analysis",
    title: r.topicSummary,
    status: r.status,
    subredditId: null,
    subredditName: null,
    targetUsername: null,
    postUrl: null,
    progress: r.threadsDone ?? null,
    total: r.threadsTotal ?? null,
    errorMessage: r.errorMessage ?? null,
    createdAt: r.createdAt,
    completedAt: r.completedAt ?? null,
    launchedBy: r.createdBy ?? null,
  }));

  // Newest first; deterministic tie-breakers (source, then id desc) keep ordering
  // stable when two rows share a createdAt timestamp, so pagination doesn't
  // shuffle equal-time rows between refetches.
  const merged = [...jobItems, ...reportItems].sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    if (byTime !== 0) return byTime;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return b.id - a.id;
  });
  const page = merged.slice(offset, offset + limit);

  res.json({
    total: merged.length,
    jobs: page.map((it) => ({
      source: it.source,
      id: it.id,
      jobType: it.jobType,
      title: it.title,
      status: it.status,
      subredditId: it.subredditId,
      subredditName: it.subredditName,
      targetUsername: it.targetUsername,
      postUrl: it.postUrl,
      progress: it.progress,
      total: it.total,
      errorMessage: it.errorMessage,
      createdAt: it.createdAt.toISOString(),
      completedAt: it.completedAt ? it.completedAt.toISOString() : null,
      launchedBy: it.launchedBy,
    })),
  });
});

router.post("/jobs/crawl", async (req, res): Promise<void> => {
  const parsed = StartCrawlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { mode } = parsed.data;

  // User investigation: a single Reddit user's full history via Arctic Shift
  // (free archive, includes since-deleted content). No subreddit/Apify involved.
  if (mode === "user") {
    const username = parsed.data.username?.trim().replace(/^\/?(?:u|user)\//i, "").replace(/^@/, "");
    if (!username) {
      res.status(400).json({ error: "A Reddit username is required for a user investigation." });
      return;
    }
    const contentType = parsed.data.contentType ?? "both";
    let maxItems = 1000;
    if (parsed.data.maxItems != null) {
      if (!Number.isInteger(parsed.data.maxItems) || parsed.data.maxItems < 1 || parsed.data.maxItems > 5000) {
        res.status(400).json({ error: "maxItems must be an integer between 1 and 5000" });
        return;
      }
      maxItems = parsed.data.maxItems;
    }
    const refresh = parsed.data.refresh ?? "incremental";

    const [job] = await db
      .insert(jobsTable)
      .values({
        jobType: "investigate_user",
        status: "pending",
        targetUsername: username,
        total: 0,
        progress: 0,
        createdBy: req.session.user ?? null,
      })
      .returning();

    runUserInvestigation({
      jobId: job.id,
      username,
      contentType,
      maxItems,
      refresh,
      launchedBy: req.session.user ?? null,
    }).catch(() => {});

    res.status(202).json({
      id: job.id,
      jobType: job.jobType,
      status: job.status,
      subredditId: job.subredditId ?? null,
      targetUsername: job.targetUsername ?? null,
      progress: job.progress ?? null,
      total: job.total ?? null,
      errorMessage: job.errorMessage ?? null,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    });
    return;
  }

  let subredditId: number;
  let subredditName: string;
  let postLimit = 50;
  let postUrl: string | undefined;

  if (mode === "comments") {
    // Comments-only crawls target one specific thread; the subreddit comes from
    // the post URL (not the dropdown), and we never scrape whole-subreddit comments.
    const rawUrl = parsed.data.postUrl?.trim();
    if (!rawUrl) {
      res.status(400).json({ error: "A Reddit post URL is required for a comments-only crawl." });
      return;
    }
    const parsedUrl = parseRedditPostUrl(rawUrl);
    if (!parsedUrl) {
      res.status(400).json({
        error: "Invalid Reddit post URL. Expected a link like https://www.reddit.com/r/<sub>/comments/<id>/…",
      });
      return;
    }
    postUrl = parsedUrl.normalizedUrl;
    const sub = await findOrCreateSubreddit(parsedUrl.subreddit);
    subredditId = sub.id;
    subredditName = sub.subredditName;
  } else {
    // posts / both: crawl a subreddit's listing. The target can be given as a
    // typed name (found-or-created on the fly, so it needn't be pre-registered)
    // or, for backward compatibility, as the id of an already-tracked subreddit.
    if (parsed.data.postLimit != null) {
      if (!Number.isInteger(parsed.data.postLimit) || parsed.data.postLimit < 1 || parsed.data.postLimit > 1000) {
        res.status(400).json({ error: "postLimit must be an integer between 1 and 1000" });
        return;
      }
      postLimit = parsed.data.postLimit;
    }

    const typedName = parsed.data.subreddit?.trim().replace(/^\/?r\//i, "");
    if (typedName) {
      const sub = await findOrCreateSubreddit(typedName);
      subredditId = sub.id;
      subredditName = sub.subredditName;
    } else if (parsed.data.subredditId != null) {
      const [subreddit] = await db.select().from(subredditsTable).where(eq(subredditsTable.id, parsed.data.subredditId));
      if (!subreddit) {
        res.status(400).json({ error: "Subreddit not found" });
        return;
      }
      subredditId = subreddit.id;
      subredditName = subreddit.subredditName;
    } else {
      res.status(400).json({ error: "A target subreddit is required for this crawl mode." });
      return;
    }
  }

  // Comments mode no longer caps to a fixed number, so the total isn't known
  // upfront — the UI shows the live comment count instead of progress/total.
  const total = mode === "comments" ? 0 : postLimit;

  const [job] = await db
    .insert(jobsTable)
    .values({
      jobType: mode === "comments" ? "crawl_comments" : "crawl_subreddit",
      status: "pending",
      subredditId,
      postUrl: postUrl ?? null,
      total,
      progress: 0,
      createdBy: req.session.user ?? null,
    })
    .returning();

  runCrawlJob({ jobId: job.id, mode, subredditId, subredditName, postLimit, postUrl, launchedBy: req.session.user ?? null }).catch(() => {});

  res.status(202).json({
    id: job.id,
    jobType: job.jobType,
    status: job.status,
    subredditId: job.subredditId ?? null,
    targetUsername: job.targetUsername ?? null,
    progress: job.progress ?? null,
    total: job.total ?? null,
    errorMessage: job.errorMessage ?? null,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  });
});

router.post("/jobs/classify", async (req, res): Promise<void> => {
  if (await isClassificationRunning()) {
    res.status(200).json({ status: "already_running", pending: 0 });
    return;
  }

  const pending = await countUnanalyzedUsers();
  if (pending === 0) {
    res.status(200).json({ status: "nothing_to_do", pending: 0 });
    return;
  }

  classifyUnanalyzedUsers(req.session.user ?? null).catch((err) => {
    logger.error({ err }, "Resume classification failed");
  });

  res.status(202).json({ status: "started", pending });
});

router.delete("/jobs/:id", async (req, res): Promise<void> => {
  const params = CancelJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  await db.update(jobsTable).set({ status: "cancelled", completedAt: new Date() }).where(eq(jobsTable.id, params.data.id));

  res.sendStatus(204);
});

/**
 * Reddit fullname (`t3_<id>`) of our newest stored post for a subreddit, used as
 * the `before=` cursor anchor so a crawl fetches only posts newer than this one.
 * Returns null when we have no dated post yet (first crawl → full scrape).
 */
async function getNewestPostFullname(subredditId: number): Promise<string | null> {
  const [newest] = await db
    .select({ redditPostId: postsTable.redditPostId })
    .from(postsTable)
    .where(and(eq(postsTable.subredditId, subredditId), isNotNull(postsTable.postedAt)))
    .orderBy(desc(postsTable.postedAt))
    .limit(1);
  const id = newest?.redditPostId;
  if (!id) return null;
  return id.startsWith("t3_") ? id : `t3_${id}`;
}

type CrawlMode = "posts" | "comments" | "both";

interface RunCrawlParams {
  jobId: number;
  mode: CrawlMode;
  subredditId: number;
  subredditName: string;
  postLimit: number;
  /** Required for mode="comments": the specific thread to scrape comments from. */
  postUrl?: string;
  /** Username that launched this crawl, threaded into the auto-classify batch. */
  launchedBy?: string | null;
}

/**
 * Ingest one Apify dataset of Reddit items into posts/comments + users. Returns
 * how many genuinely-new rows were persisted plus the raw item count, so the
 * caller can tell "nothing new" (items seen, all duplicates) apart from "empty
 * run" (a real failure). Shared by live crawls and dataset recovery.
 */
async function ingestRedditItems(params: {
  jobId: number;
  subredditId: number;
  mode: CrawlMode;
  items: Array<Record<string, unknown>>;
}): Promise<{ posts: number; comments: number; commentsSeen: number; itemsSeen: number }> {
  const { jobId, subredditId, mode, items } = params;
  const storePosts = mode !== "comments";
  const storeComments = mode !== "posts";

  let posts = 0;
  let comments = 0;
  // Counts every valid comment returned by Apify — including ones already in
  // the DB (onConflictDoNothing skips). Used as the progress/total for
  // crawl_comments jobs so re-crawling a thread shows the real comment count.
  let commentsSeen = 0;

  // Helper to classify an Apify Reddit item the same way the insert loop does.
  const classify = (item: Record<string, unknown>) => {
    const dataType = pickStr(item, "dataType", "type");
    const author = pickStr(item, "username", "author", "authorName");
    const isComment = dataType === "comment" || (!item.title && (item.body || item.text) && !dataType);
    return { author, isComment };
  };

  // Pass 1: find items that came back tombstoned ("[ Removed by Reddit ]" etc.)
  // and ask the Arctic Shift archive for their real bodies. Best-effort and
  // gated by a toggle (default ON); failures yield empty maps and never block
  // the crawl. Apify stays the primary source — Arctic only heals deletions.
  let recoveredPosts = new Map<string, { body: string; score: number }>();
  let recoveredComments = new Map<string, { body: string; score: number }>();
  if (await isArcticFallbackEnabled()) {
    const postIds: string[] = [];
    const commentIds: string[] = [];
    for (const item of items) {
      const { author, isComment } = classify(item);
      if (!author || author === "[deleted]") continue;
      if (isComment) {
        if (!storeComments) continue;
        const id = pickStr(item, "id", "commentId", "parsedId");
        const body = pickStr(item, "body", "text", "comment");
        if (id && isRemovedBody(body)) commentIds.push(id);
      } else {
        if (!storePosts) continue;
        const id = pickStr(item, "id", "postId", "parsedId");
        const body = pickStr(item, "body", "text", "selftext");
        if (id && isRemovedBody(body)) postIds.push(id);
      }
    }
    if (postIds.length > 0) recoveredPosts = await recoverRemovedBodies("posts", postIds);
    if (commentIds.length > 0) recoveredComments = await recoverRemovedBodies("comments", commentIds);
  }

  for (const item of items) {
    const { author, isComment } = classify(item);
    if (!author || author === "[deleted]") continue;

    if (isComment) {
      if (!storeComments) continue;
      const id = pickStr(item, "id", "commentId", "parsedId");
      const body = pickStr(item, "body", "text", "comment");
      if (!id || !body) continue;
      const rec = isRemovedBody(body) ? recoveredComments.get(id) : undefined;
      const commentUrl = pickStr(item, "url", "permalink", "link");
      commentsSeen++;
      const inserted = await db
        .insert(commentsTable)
        .values({
          subredditId,
          redditCommentId: id,
          author,
          body: rec?.body ?? body,
          score: rec?.score ?? pickNum(item, "upVotes", "score", "upvotes"),
          parentId: pickStr(item, "postId", "parentId", "parent_id"),
          permalink: isCommentPermalink(commentUrl) ? commentUrl : null,
          postedAt: parseDate(pickStr(item, "createdAt", "created", "createdAtFormatted")),
          recoveredAt: rec ? new Date() : null,
        })
        .onConflictDoNothing()
        .returning({ id: commentsTable.id });
      // Only count/attribute when a genuinely new row was persisted, so that
      // duplicate items in the Apify dataset don't inflate user totals.
      if (inserted.length > 0) {
        await upsertUser(author, "comment");
        comments++;
      }
      // In comments-only mode, use all-seen count (not just new inserts) so
      // the progress reflects the real thread size even on re-crawls.
      if (mode === "comments") {
        await db.update(jobsTable).set({ progress: commentsSeen }).where(eq(jobsTable.id, jobId));
      }
    } else {
      if (!storePosts) continue;
      const id = pickStr(item, "id", "postId", "parsedId");
      const title = pickStr(item, "title");
      if (!id || !title) continue;
      const body = pickStr(item, "body", "text", "selftext");
      const rec = isRemovedBody(body) ? recoveredPosts.get(id) : undefined;
      const inserted = await db
        .insert(postsTable)
        .values({
          subredditId,
          redditPostId: id,
          title,
          body: rec?.body ?? body,
          author,
          score: rec?.score ?? pickNum(item, "upVotes", "score", "upvotes"),
          permalink: pickStr(item, "url", "permalink", "link") ?? "",
          postedAt: parseDate(pickStr(item, "createdAt", "created", "createdAtFormatted")),
          recoveredAt: rec ? new Date() : null,
        })
        .onConflictDoNothing()
        .returning({ id: postsTable.id });
      if (inserted.length > 0) {
        await upsertUser(author, "post");
        posts++;
        await db.update(jobsTable).set({ progress: posts }).where(eq(jobsTable.id, jobId));
      }
    }
  }

  return { posts, comments, commentsSeen, itemsSeen: items.length };
}

async function runCrawlJob({ jobId, mode, subredditId, subredditName, postLimit, postUrl, launchedBy }: RunCrawlParams) {
  try {
    await db.update(jobsTable).set({ status: "running" }).where(eq(jobsTable.id, jobId));

    const token = await getSetting(SETTING_APIFY_TOKEN);
    if (!token) {
      throw new Error("Apify API key not configured. Add it in the Admin Panel to enable crawling.");
    }
    const actorId = (await getSetting(SETTING_APIFY_ACTOR_ID)) ?? DEFAULT_APIFY_ACTOR_ID;
    const cleanSub = subredditName.replace(/^r\//, "");

    const plainUrl = `https://www.reddit.com/r/${cleanSub}/new/`;

    // What each mode wants: "posts" stores posts only; "both" stores posts and
    // their comments; "comments" stores only comments (from a single thread URL).
    const wantComments = mode !== "posts";
    const storePosts = mode !== "comments";
    const storeComments = mode !== "posts";

    const buildInput = (startUrl: string): Record<string, unknown> => ({
      startUrls: [{ url: startUrl }],
      skipComments: !wantComments,
      skipUserPosts: true,
      skipCommunity: true,
      searchPosts: true,
      searchComments: false,
      searchCommunities: false,
      searchUsers: false,
      sort: "new",
      maxItems: mode === "comments" ? COMMENT_CRAWL_LIMIT + 1 : postLimit * 4,
      maxPostCount: mode === "comments" ? 1 : postLimit,
      maxComments: mode === "comments" ? COMMENT_CRAWL_LIMIT : wantComments ? 20 : 0,
      proxy: { useApifyProxy: true },
    });

    // Ingest one Apify dataset. Returns how many genuinely-new rows were
    // persisted plus the raw item count, so the caller can tell "nothing new"
    // (items seen, all duplicates) apart from "empty run" (a real failure).
    const ingest = (items: Array<Record<string, unknown>>) =>
      ingestRedditItems({ jobId, subredditId, mode, items });

    const runWith = async (startUrl: string) => {
      const items = await runApifyActor(token, actorId, buildInput(startUrl), async (status) => {
        logger.info({ jobId, status }, "Apify run status");
      });
      logger.info({ jobId, itemCount: items.length, sample: items[0], startUrl }, "Apify dataset received");
      return ingest(items);
    };

    let result: { posts: number; comments: number; commentsSeen: number; itemsSeen: number };

    if (mode === "comments") {
      // Comments-only targets a single specific thread, so the incremental
      // subreddit cursor doesn't apply; dedup keeps re-crawls of the same thread
      // from duplicating comments.
      if (!postUrl) throw new Error("Comments-only crawl is missing its post URL.");
      result = await runWith(postUrl);
      if (result.itemsSeen === 0) {
        throw new Error(
          "Apify returned nothing for that post URL. Double-check the link — and note that comments require a comment-capable (paid) Apify actor; the free lite actor returns posts only.",
        );
      }
      if (result.comments === 0) {
        logger.info(
          { jobId, postUrl },
          "Comment crawl found no new comments (thread may have none, all were duplicates, or the actor tier returns no comments)",
        );
      }
    } else {
      // Incremental fetch: Reddit's `before=<fullname>` cursor returns only posts
      // newer than our newest stored post, so the actor skips content we already
      // have. The lite actor may ignore the param (harmless — dedup absorbs any
      // repeats) or the anchor post may have been removed, in which case the run
      // comes back empty; we then fall back to a full scrape so nothing is missed.
      const anchor = await getNewestPostFullname(subredditId);
      const cursorUrl = anchor ? `${plainUrl}?before=${anchor}` : null;

      result = await runWith(cursorUrl ?? plainUrl);
      if (cursorUrl && result.itemsSeen === 0) {
        logger.info({ jobId, anchor }, "Incremental cursor returned nothing; falling back to full scrape");
        result = await runWith(plainUrl);
      }

      // An empty dataset from an active subreddit's full listing signals a real
      // problem (Apify budget exhausted, actor output changed), not "nothing new".
      if (result.itemsSeen === 0) {
        throw new Error("Apify run returned no usable data. The actor's output format may differ — check server logs for a sample item.");
      }
      // itemsSeen > 0 but zero new rows just means everything was a duplicate —
      // i.e. no new content since the last crawl. That's a successful no-op.
      if (result.posts === 0 && result.comments === 0) {
        logger.info({ jobId, subredditName }, "Crawl found no new content since last run");
      }
    }

    const { posts, comments, commentsSeen } = result;
    const progress = mode === "comments" ? commentsSeen : posts;

    await db
      .update(jobsTable)
      .set({ status: "completed", progress, completedAt: new Date() })
      .where(eq(jobsTable.id, jobId));

    logger.info({ jobId, mode, posts, comments, subredditName }, "Crawl job completed");

    // Classification is what turns raw users into profiled archetypes. Run it
    // automatically after a crawl so newly ingested users don't show up
    // unclassified.
    await classifyUnanalyzedUsers(launchedBy ?? null);
  } catch (err) {
    logger.error({ err, jobId }, "Crawl job failed");
    await db
      .update(jobsTable)
      .set({ status: "failed", errorMessage: err instanceof Error ? err.message : String(err), completedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
  }
}

interface RunUserInvestigationParams {
  jobId: number;
  username: string;
  contentType: "posts" | "comments" | "both";
  maxItems: number;
  refresh: "incremental" | "full";
  launchedBy?: string | null;
}

/**
 * Investigate a single Reddit user via the Arctic Shift archive: fetch their
 * posts and/or comments (optionally only content newer than what's stored),
 * ingest with full dedup, recompute their stats, then auto-classify so the new
 * user doesn't sit unanalyzed. Arctic Shift is the only source for this — there
 * is no fallback — so an outage surfaces as a clear job failure.
 */
async function runUserInvestigation({
  jobId,
  username,
  contentType,
  maxItems,
  refresh,
  launchedBy,
}: RunUserInvestigationParams) {
  try {
    await db.update(jobsTable).set({ status: "running" }).where(eq(jobsTable.id, jobId));

    const { posts, comments, canonical } = await crawlUserViaArcticShift({
      username,
      contentType,
      maxItems,
      refresh,
      onProgress: async (n) => {
        await db.update(jobsTable).set({ progress: n }).where(eq(jobsTable.id, jobId));
      },
    });
    const processed = posts + comments;

    // Single action: a crawl from the Investigate page must leave behind a fully
    // analyzed profile (archetypes + self-disclosed identifiers), with no manual
    // "Re-Analysis" step. Run the SAME pipeline as the profile button on the user
    // we just crawled. Analysis failure fails the job so the gap is visible.
    const userId = await findUserIdByUsername(canonical ?? username);
    if (userId == null) {
      // A successful crawl always upserts the user row, so a missing row means the
      // single-action contract (crawl ⇒ analyzed profile) cannot be honored — fail
      // loudly rather than silently completing without a rebuilt profile.
      throw new Error(`User row not found after crawl for "${username}"; cannot build profile`);
    }
    // OpenAI cost for the investigate analysis + flag pass is attributed to the
    // app account that launched the investigation. (The crawl itself is free —
    // it uses the Arctic Shift archive, not Apify.)
    await withCostContext({ appUser: launchedBy ?? null, category: "investigate" }, async () => {
      await analyzeAndPersistUser(userId, canonical ?? username);

      // AI-flag potentially concerning comments from this user's history (Reddit
      // investigate only). Incremental after the first run. Supplementary, so it
      // runs in its own try/catch: a flag-pass failure must not fail an otherwise
      // successful investigation (the profile is already persisted above).
      try {
        await flagUserComments(userId, canonical ?? username);
      } catch (flagErr) {
        logger.error({ flagErr, jobId, username }, "User comment flagging failed (non-fatal)");
      }
    });

    await db
      .update(jobsTable)
      .set({ status: "completed", progress: processed, total: processed, completedAt: new Date() })
      .where(eq(jobsTable.id, jobId));

    logger.info({ jobId, username, posts, comments, refresh }, "User investigation completed");

    // Catch up any OTHER users still missing an archetype profile (e.g. stragglers
    // from earlier subreddit crawls). The just-investigated user is already fully
    // analyzed above, so it is skipped here (its analysis is newer than its content).
    // Isolated in its own try/catch: this job is already marked completed, so an
    // unrelated batch failure must not flip a successful investigation to "failed".
    try {
      await classifyUnanalyzedUsers(launchedBy ?? null);
    } catch (batchErr) {
      logger.error({ batchErr, jobId, username }, "Post-investigation straggler classification failed");
    }
  } catch (err) {
    logger.error({ err, jobId, username }, "User investigation failed");
    await db
      .update(jobsTable)
      .set({ status: "failed", errorMessage: err instanceof Error ? err.message : String(err), completedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
  }
}

/**
 * Classify every user that has ingested content but no analysis yet. Runs the
 * same OpenAI analysis as the per-user endpoint, sequentially to avoid hammering
 * the API. Tracks progress via an `analyze_batch` job record.
 */
const MAX_CLASSIFY_PER_RUN = 500;

async function isClassificationRunning(): Promise<boolean> {
  const [running] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(eq(jobsTable.jobType, "analyze_batch"), eq(jobsTable.status, "running")))
    .limit(1);
  return Boolean(running);
}

async function countUnanalyzedUsers(): Promise<number> {
  // Mirror classifyUnanalyzedUsers' targeting: users never analyzed OR with new
  // content since their latest analysis. Keeps the /jobs/classify gate accurate
  // now that reclassification (not just first-time analysis) is supported.
  const rows = await db.execute<{ count: number }>(
    sql`
      SELECT COUNT(*)::int AS count
      FROM reddit_users u
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_at FROM analyses WHERE user_id = u.id
      ) la ON TRUE
      WHERE la.last_at IS NULL
         OR EXISTS (SELECT 1 FROM posts p WHERE p.author = u.username AND p.created_at > la.last_at)
         OR EXISTS (SELECT 1 FROM comments c WHERE c.author = u.username AND c.created_at > la.last_at)
    `,
  );
  return Number(rows.rows?.[0]?.count ?? 0);
}

/**
 * Background jobs live in-memory, so a server restart leaves their DB rows stuck
 * at "running"/"pending" forever. On boot, mark them as failed so the queue
 * reflects reality and the classification concurrency guard isn't blocked by a
 * zombie job. Resuming is safe because classification only targets users with no
 * existing analysis — interrupted work is simply picked up again.
 */
export async function cleanupOrphanedJobs(): Promise<void> {
  const orphaned = await db
    .update(jobsTable)
    .set({
      status: "failed",
      errorMessage: "Interrupted by server restart",
      completedAt: new Date(),
      targetUsername: null,
    })
    .where(inArray(jobsTable.status, ["running", "pending"]))
    .returning({ id: jobsTable.id });
  if (orphaned.length > 0) {
    logger.info({ count: orphaned.length }, "Marked orphaned jobs as failed on startup");
  }

  // Topic/sentiment analyses run as detached async functions too, so a restart
  // leaves their rows stuck at "running"/"pending" forever with no recovery.
  // Reconcile them the same way so the UI unblocks and the user can re-run.
  const orphanedAnalyses = await db
    .update(topicAnalysesTable)
    .set({
      status: "failed",
      errorMessage:
        "Interrupted by a server restart before the analysis finished. Please re-run.",
      completedAt: new Date(),
    })
    .where(inArray(topicAnalysesTable.status, ["running", "pending"]))
    .returning({ id: topicAnalysesTable.id });
  if (orphanedAnalyses.length > 0) {
    logger.info(
      { count: orphanedAnalyses.length },
      "Marked orphaned topic analyses as failed on startup",
    );
  }
}

async function runBatchClassify(targets: Array<{ id: number; username: string }>, launchedBy: string | null = null): Promise<void> {
  if (targets.length === 0) return;

  // Safety cap on runaway cost/runtime; the remainder is picked up next crawl.
  const capped = targets.slice(0, MAX_CLASSIFY_PER_RUN);

  // Atomic concurrency guard: the `one_running_analyze_batch` partial unique
  // index lets at most one running analyze_batch row exist. If another pass is
  // already running, this insert conflicts and returns nothing, so we skip —
  // no race window between a separate read-check and the insert.
  const [job] = await db
    .insert(jobsTable)
    .values({ jobType: "analyze_batch", status: "running", total: capped.length, progress: 0, createdBy: launchedBy })
    .onConflictDoNothing()
    .returning();

  if (!job) {
    logger.info("Auto-classification already in progress; skipping");
    return;
  }

  logger.info({ jobId: job.id, count: capped.length, totalQueued: targets.length }, "Classification batch started");

  let done = 0;
  let failed = 0;
  try {
  for (const t of capped) {
    // Surface the user currently being classified so the admin pipeline queue
    // can show who is being analysed right now (cleared on completion).
    await db.update(jobsTable).set({ targetUsername: t.username }).where(eq(jobsTable.id, job.id));
    try {
      const posts = await db
        .select({ title: postsTable.title, body: postsTable.body })
        .from(postsTable)
        .where(eq(postsTable.author, t.username))
        .limit(30);
      const comments = await db
        .select({ body: commentsTable.body })
        .from(commentsTable)
        .where(eq(commentsTable.author, t.username))
        .limit(100);

      const result = await analyzeUserContent(t.username, posts, comments);

      // Supersede the old profile and write the new one atomically: if anything
      // fails mid-write, the transaction rolls back so the user never ends up
      // with zero current-profile rows. History rows are retained (isLatest=false).
      await db.transaction(async (tx) => {
        await tx
          .update(archetypeScoresTable)
          .set({ isLatest: false })
          .where(and(eq(archetypeScoresTable.userId, t.id), eq(archetypeScoresTable.isLatest, true)));
        await tx
          .update(analysesTable)
          .set({ isLatest: false })
          .where(and(eq(analysesTable.userId, t.id), eq(analysesTable.isLatest, true)));

        const [analysis] = await tx
          .insert(analysesTable)
          .values({
            userId: t.id,
            dominantArchetypes: result.dominant_archetypes,
            summary: result.summary,
            recurringThemes: result.recurring_themes,
            themeLabels: result.theme_labels ?? [],
            confidenceNotes: result.confidence_notes,
            rawResponse: JSON.stringify(result),
          })
          .returning();

        const scoreInserts = Object.entries(result.archetypes)
          .filter(([, v]) => v.score > 0)
          .map(([key, val]) => {
            const archetype = ARCHETYPES.find((a) => a.key === key);
            return {
              analysisId: analysis.id,
              userId: t.id,
              archetypeKey: key,
              archetypeName: archetype?.name ?? key,
              score: val.score,
              confidence: val.confidence,
              evidence: val.evidence,
            };
          });

        if (scoreInserts.length > 0) {
          await tx.insert(archetypeScoresTable).values(scoreInserts);
        }
      });
    } catch (err) {
      // Do NOT persist anything on failure — the user stays unanalyzed and will
      // be retried on the next crawl rather than locked into a bad result.
      failed++;
      logger.error({ err, username: t.username }, "Classification failed for user");
    }

    done++;
    await db.update(jobsTable).set({ progress: done }).where(eq(jobsTable.id, job.id));
  }

    await db
      .update(jobsTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        targetUsername: null,
        errorMessage: failed > 0 ? `${failed} of ${capped.length} users failed to classify (will retry next crawl)` : null,
      })
      .where(eq(jobsTable.id, job.id));

    logger.info({ jobId: job.id, classified: done - failed, failed }, "Classification batch completed");
  } catch (err) {
    // A failure OUTSIDE the per-user guard (e.g. a DB write) would otherwise
    // leave the job stuck "running" with a stale targetUsername. Fail it cleanly
    // and clear the current-user marker so the queue doesn't mislabel it.
    logger.error({ err, jobId: job.id }, "Classification batch crashed");
    await db
      .update(jobsTable)
      .set({
        status: "failed",
        completedAt: new Date(),
        targetUsername: null,
        errorMessage: "Classification batch crashed unexpectedly",
      })
      .where(eq(jobsTable.id, job.id));
  }
}

async function classifyUnanalyzedUsers(launchedBy: string | null = null): Promise<void> {
  // Targets = users never analyzed OR users with posts/comments ingested since
  // their latest analysis. Re-analyzing on new content keeps a user's archetype
  // profile current; users with no new content are skipped to bound AI cost.
  const targetRows = await db.execute<{ id: number; username: string }>(
    sql`
      SELECT u.id, u.username
      FROM reddit_users u
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_at FROM analyses WHERE user_id = u.id
      ) la ON TRUE
      WHERE la.last_at IS NULL
         OR EXISTS (SELECT 1 FROM posts p WHERE p.author = u.username AND p.created_at > la.last_at)
         OR EXISTS (SELECT 1 FROM comments c WHERE c.author = u.username AND c.created_at > la.last_at)
    `,
  );
  const targets: Array<{ id: number; username: string }> = (targetRows.rows ?? []).map((r) => ({
    id: Number(r.id),
    username: r.username,
  }));
  await runBatchClassify(targets, launchedBy);
}

export default router;
