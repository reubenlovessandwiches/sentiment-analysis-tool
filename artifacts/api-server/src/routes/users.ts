import { Router, type IRouter } from "express";
import { db, redditUsersTable, analysesTable, archetypeScoresTable, postsTable, commentsTable, jobsTable, subredditsTable, flaggedCommentsTable } from "@workspace/db";
import { eq, desc, sql, count, ilike, and, gt } from "drizzle-orm";
import {
  GetUserParams,
  ListUsersQueryParams,
  AnalyzeUserParams,
} from "@workspace/api-zod";
import { crawlUserViaArcticShift, hasArcticCrawl } from "../lib/user-investigation";
import { analyzeAndPersistUser, flagUserComments } from "../lib/user-analysis";
import { buildCommentPermalink } from "../lib/crawl";
import { withCostContext } from "../lib/cost-context";

const router: IRouter = Router();

router.get("/users", async (req, res): Promise<void> => {
  const params = ListUsersQueryParams.safeParse(req.query);
  const limit = params.success && params.data.limit ? params.data.limit : 50;
  const offset = params.success && params.data.offset ? params.data.offset : 0;
  const q = params.success && params.data.q ? params.data.q.trim() : undefined;
  const archetypeFilter = params.success ? params.data.archetype : undefined;
  const minScore = params.success && params.data.minScore != null ? params.data.minScore : undefined;
  const sortBy = params.success && params.data.sortBy ? params.data.sortBy : "recent";

  // Row-level filters (applied before grouping) so the total count stays exact.
  const conditions = [];
  if (q) conditions.push(ilike(redditUsersTable.username, `%${q}%`));
  if (archetypeFilter) {
    const threshold = minScore ?? 1;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${archetypeScoresTable} s WHERE s.user_id = ${redditUsersTable.id} AND s.is_latest AND s.archetype_key = ${archetypeFilter} AND s.score >= ${threshold})`,
    );
  } else if (minScore != null) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${archetypeScoresTable} s WHERE s.user_id = ${redditUsersTable.id} AND s.is_latest AND s.score >= ${minScore})`,
    );
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orderByClause =
    sortBy === "username"
      ? redditUsersTable.username
      : sortBy === "posts"
        ? desc(redditUsersTable.totalPosts)
        : sortBy === "score"
          ? desc(sql`MAX(${archetypeScoresTable.score})`)
          : desc(redditUsersTable.lastSeen);

  const usersRaw = await db
    .select({
      id: redditUsersTable.id,
      username: redditUsersTable.username,
      firstSeen: redditUsersTable.firstSeen,
      lastSeen: redditUsersTable.lastSeen,
      totalComments: redditUsersTable.totalComments,
      totalPosts: redditUsersTable.totalPosts,
      dominantArchetype: sql<string>`(array_agg(${archetypeScoresTable.archetypeName} ORDER BY ${archetypeScoresTable.score} DESC))[1]`,
      topScore: sql<number>`MAX(${archetypeScoresTable.score})`,
      // Total analyses in the user's history (not just the latest profile).
      analysisCount: sql<number>`(SELECT COUNT(*) FROM ${analysesTable} a WHERE a.user_id = ${redditUsersTable.id})`,
    })
    .from(redditUsersTable)
    .leftJoin(
      archetypeScoresTable,
      and(eq(archetypeScoresTable.userId, redditUsersTable.id), eq(archetypeScoresTable.isLatest, true)),
    )
    .where(whereClause)
    .groupBy(redditUsersTable.id)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const [totalResult] = await db.select({ count: count() }).from(redditUsersTable).where(whereClause);

  const users = usersRaw.map((u) => ({
    user: {
      id: u.id,
      username: u.username,
      firstSeen: u.firstSeen?.toISOString() ?? null,
      lastSeen: u.lastSeen?.toISOString() ?? null,
      totalComments: u.totalComments,
      totalPosts: u.totalPosts,
    },
    dominantArchetype: u.dominantArchetype ?? null,
    topScore: u.topScore ? Number(u.topScore) : null,
    analysisCount: Number(u.analysisCount ?? 0),
  }));

  res.json({ users, total: Number(totalResult?.count ?? 0) });
});

router.get("/users/:username", async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db
    .select()
    .from(redditUsersTable)
    .where(eq(redditUsersTable.username, params.data.username));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const latestAnalysis = await db
    .select()
    .from(analysesTable)
    .where(eq(analysesTable.userId, user.id))
    .orderBy(desc(analysesTable.createdAt))
    .limit(1);

  const archetypeScores = latestAnalysis[0]
    ? await db
        .select()
        .from(archetypeScoresTable)
        .where(eq(archetypeScoresTable.analysisId, latestAnalysis[0].id))
        .orderBy(desc(archetypeScoresTable.score))
    : [];

  const recentPosts = await db
    .select({ id: postsTable.id, title: postsTable.title, score: postsTable.score, createdAt: postsTable.createdAt, permalink: postsTable.permalink, recoveredAt: postsTable.recoveredAt })
    .from(postsTable)
    .where(eq(postsTable.author, user.username))
    .orderBy(desc(postsTable.createdAt));

  const recentComments = await db
    .select({
      id: commentsTable.id,
      body: commentsTable.body,
      score: commentsTable.score,
      createdAt: commentsTable.createdAt,
      redditCommentId: commentsTable.redditCommentId,
      parentId: commentsTable.parentId,
      permalink: commentsTable.permalink,
      recoveredAt: commentsTable.recoveredAt,
      subredditName: subredditsTable.subredditName,
    })
    .from(commentsTable)
    .leftJoin(subredditsTable, eq(commentsTable.subredditId, subredditsTable.id))
    .where(eq(commentsTable.author, user.username))
    .orderBy(desc(commentsTable.createdAt));

  // AI-flagged "comments requiring attention" (Reddit-only). The excerpt /
  // permalink / author are joined live from the comment row so they stay in sync
  // with any later tombstone-recovery backfill. Most recently flagged first.
  const flaggedRows = await db
    .select({
      id: flaggedCommentsTable.id,
      issue: flaggedCommentsTable.issue,
      flaggedAt: flaggedCommentsTable.flaggedAt,
      body: commentsTable.body,
      createdAt: commentsTable.createdAt,
      redditCommentId: commentsTable.redditCommentId,
      parentId: commentsTable.parentId,
      permalink: commentsTable.permalink,
      subredditName: subredditsTable.subredditName,
    })
    .from(flaggedCommentsTable)
    .innerJoin(commentsTable, eq(flaggedCommentsTable.commentId, commentsTable.id))
    .leftJoin(subredditsTable, eq(commentsTable.subredditId, subredditsTable.id))
    .where(eq(flaggedCommentsTable.userId, user.id))
    .orderBy(desc(flaggedCommentsTable.flaggedAt));

  const analysis = latestAnalysis[0];

  res.json({
    user: {
      id: user.id,
      username: user.username,
      firstSeen: user.firstSeen?.toISOString() ?? null,
      lastSeen: user.lastSeen?.toISOString() ?? null,
      totalComments: user.totalComments,
      totalPosts: user.totalPosts,
      notes: user.notes ?? null,
      arcticCrawledAt: user.arcticCrawledAt?.toISOString() ?? null,
    },
    latestAnalysis: analysis
      ? {
          id: analysis.id,
          createdAt: analysis.createdAt.toISOString(),
          dominantArchetypes: analysis.dominantArchetypes,
          summary: analysis.summary,
          recurringThemes: analysis.recurringThemes,
          confidenceNotes: analysis.confidenceNotes,
          archetypeScores: archetypeScores.map((s) => ({
            archetypeKey: s.archetypeKey,
            archetypeName: s.archetypeName,
            score: s.score,
            confidence: s.confidence,
            explanation: s.explanation ?? null,
            evidence: s.evidence,
          })),
        }
      : null,
    archetypeScores: archetypeScores.map((s) => ({
      archetypeKey: s.archetypeKey,
      archetypeName: s.archetypeName,
      score: s.score,
      confidence: s.confidence,
      explanation: s.explanation ?? null,
      evidence: s.evidence,
    })),
    recentPosts: recentPosts.map((p) => ({
      id: p.id,
      title: p.title,
      score: p.score,
      createdAt: p.createdAt.toISOString(),
      permalink: p.permalink,
      recoveredAt: p.recoveredAt?.toISOString() ?? null,
    })),
    recentComments: recentComments.map((c) => ({
      id: c.id,
      body: c.body,
      score: c.score,
      createdAt: c.createdAt.toISOString(),
      subreddit: c.subredditName ?? "",
      permalink: buildCommentPermalink(c.permalink, c.subredditName, c.parentId, c.redditCommentId),
      recoveredAt: c.recoveredAt?.toISOString() ?? null,
    })),
    identifiers: analysis?.identifiers ?? [],
    flaggedComments: flaggedRows.map((f) => ({
      id: f.id,
      issue: f.issue,
      excerpt: f.body,
      author: user.username,
      subreddit: f.subredditName ?? "",
      permalink: buildCommentPermalink(f.permalink, f.subredditName, f.parentId, f.redditCommentId),
      createdAt: f.createdAt.toISOString(),
      flaggedAt: f.flaggedAt.toISOString(),
    })),
  });
});

router.post("/users/:username/analyze", async (req, res): Promise<void> => {
  const params = AnalyzeUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db
    .select()
    .from(redditUsersTable)
    .where(eq(redditUsersTable.username, params.data.username));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [job] = await db
    .insert(jobsTable)
    .values({
      jobType: "analyze_user",
      status: "pending",
      targetUsername: user.username,
      createdBy: req.session.user ?? null,
    })
    .returning();

  runUserAnalysis(user.id, user.username, job.id, job.createdBy ?? null).catch(() => {});

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

router.post("/users/:username/reanalyze", async (req, res): Promise<void> => {
  const params = AnalyzeUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db
    .select()
    .from(redditUsersTable)
    .where(eq(redditUsersTable.username, params.data.username));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [job] = await db
    .insert(jobsTable)
    .values({
      jobType: "reanalyze_user",
      status: "pending",
      targetUsername: user.username,
      createdBy: req.session.user ?? null,
    })
    .returning();

  runUserReanalysis(user.id, user.username, job.id).catch(() => {});

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

router.get("/users/:username/trends", async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db
    .select()
    .from(redditUsersTable)
    .where(eq(redditUsersTable.username, params.data.username));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const analyses = await db
    .select({ id: analysesTable.id, createdAt: analysesTable.createdAt })
    .from(analysesTable)
    .where(eq(analysesTable.userId, user.id))
    .orderBy(analysesTable.createdAt)
    .limit(20);

  if (analyses.length === 0) {
    res.json([]);
    return;
  }

  const trendPoints: Array<{ date: string; archetypeKey: string; archetypeName: string; score: number }> = [];

  for (const analysis of analyses) {
    const scores = await db
      .select()
      .from(archetypeScoresTable)
      .where(eq(archetypeScoresTable.analysisId, analysis.id))
      .orderBy(desc(archetypeScoresTable.score))
      .limit(5);

    for (const score of scores) {
      trendPoints.push({
        // Full ISO timestamp (not just the day) so multiple analyses on the
        // same date stay distinct points instead of collapsing into one.
        date: analysis.createdAt.toISOString(),
        archetypeKey: score.archetypeKey,
        archetypeName: score.archetypeName,
        score: score.score,
      });
    }
  }

  res.json(trendPoints);
});

async function runUserAnalysis(userId: number, username: string, jobId: number, launchedBy: string | null) {
  const { logger } = await import("../lib/logger");
  try {
    await db.update(jobsTable).set({ status: "running" }).where(eq(jobsTable.id, jobId));

    // "Fetch New Data" runs the SAME pipeline as the Investigate → User crawl:
    // refresh the corpus from Arctic Shift, rebuild the profile, then AI-flag
    // concerning comments. The only difference is crawl scope — first time for
    // this user → full historical crawl; afterwards → incremental (only content
    // newer than what we already have), to avoid re-paying for full crawls.
    const refresh = (await hasArcticCrawl(username)) ? "incremental" : "full";
    await crawlUserViaArcticShift({
      username,
      contentType: "both",
      maxItems: refresh === "full" ? 5000 : 1000,
      refresh,
      onProgress: async (n) => {
        await db.update(jobsTable).set({ progress: n }).where(eq(jobsTable.id, jobId));
      },
    });

    // OpenAI cost for the analysis + flag pass is attributed to the app account
    // that launched the refresh (same attribution as the Investigate flow). The
    // crawl itself is free (Arctic Shift archive, not Apify).
    await withCostContext({ appUser: launchedBy, category: "investigate" }, async () => {
      // Rebuild the profile from the refreshed corpus (archetypes + identifiers).
      await analyzeAndPersistUser(userId, username);

      // AI-flag potentially concerning comments. Supplementary, so a flag-pass
      // failure must not fail an otherwise successful refresh.
      try {
        await flagUserComments(userId, username);
      } catch (flagErr) {
        logger.error({ flagErr, username }, "User comment flagging failed (non-fatal)");
      }
    });

    await db
      .update(jobsTable)
      .set({ status: "completed", completedAt: new Date(), progress: 1, total: 1 })
      .where(eq(jobsTable.id, jobId));
  } catch (err) {
    logger.error({ err, username }, "User analysis failed");
    await db
      .update(jobsTable)
      .set({ status: "failed", errorMessage: String(err), completedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
  }
}

async function runUserReanalysis(userId: number, username: string, jobId: number) {
  const { logger } = await import("../lib/logger");
  try {
    await db.update(jobsTable).set({ status: "running" }).where(eq(jobsTable.id, jobId));

    // Re-analyse only: rebuild the profile (archetypes + identifiers) from the
    // data already stored for this user. Does NOT crawl Arctic Shift, so no new
    // posts/comments are fetched and no crawl cost is incurred.
    await analyzeAndPersistUser(userId, username);

    // AI-flag potentially concerning comments from this user's stored history.
    // Incremental after the first run. Supplementary, so it runs in its own
    // try/catch: a flag-pass failure must not fail an otherwise successful
    // re-analysis (the profile is already persisted above).
    try {
      await flagUserComments(userId, username);
    } catch (flagErr) {
      logger.error({ flagErr, username }, "User comment flagging failed (non-fatal)");
    }

    await db
      .update(jobsTable)
      .set({ status: "completed", completedAt: new Date(), progress: 1, total: 1 })
      .where(eq(jobsTable.id, jobId));
  } catch (err) {
    logger.error({ err, username }, "User re-analysis failed");
    await db
      .update(jobsTable)
      .set({ status: "failed", errorMessage: String(err), completedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
  }
}

router.put("/users/:username/notes", async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const notes = typeof req.body?.notes === "string" ? req.body.notes || null : null;

  const [updated] = await db
    .update(redditUsersTable)
    .set({ notes })
    .where(eq(redditUsersTable.username, params.data.username))
    .returning({ id: redditUsersTable.id });

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ ok: true });
});

export default router;
