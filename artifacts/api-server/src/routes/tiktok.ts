import { Router, type IRouter } from "express";
import {
  db,
  tiktokUsersTable,
  tiktokCommentsTable,
  tiktokAnalysesTable,
  tiktokArchetypeScoresTable,
  jobsTable,
  topicAnalysisPostsTable,
} from "@workspace/db";
import { sql, count, eq, desc, gt, and, ilike } from "drizzle-orm";
import {
  ListTikTokUsersQueryParams,
  SearchTikTokUsersQueryParams,
  GetTikTokArchetypeUsersParams,
  GetTikTokArchetypeUsersQueryParams,
} from "@workspace/api-zod";
import { ARCHETYPES } from "../lib/archetypes";
import { classifyUnanalyzedTikTokUsers } from "../lib/tiktok-classify";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** True if an TikTok classification batch is currently running. */
async function isTikTokClassificationRunning(): Promise<boolean> {
  const [running] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(eq(jobsTable.jobType, "analyze_tiktok_batch"), eq(jobsTable.status, "running")))
    .limit(1);
  return Boolean(running);
}

/**
 * Count TikTok users that have ingested content but no current analysis (or
 * new content since their latest one). Mirrors the targeting in
 * classifyUnanalyzedTikTokUsers so the /tiktok/classify gate stays accurate.
 */
async function countUnanalyzedTikTokUsers(): Promise<number> {
  const rows = await db.execute<{ count: number }>(
    sql`
      SELECT COUNT(*)::int AS count
      FROM tiktok_users u
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_at FROM tiktok_analyses WHERE user_id = u.id
      ) la ON TRUE
      WHERE la.last_at IS NULL
         OR EXISTS (
           SELECT 1 FROM tiktok_comments c
           WHERE c.author_username = u.username AND c.created_at > la.last_at
         )
    `,
  );
  return Number(rows.rows?.[0]?.count ?? 0);
}

/**
 * Classify every unanalyzed TikTok user. classifyUnanalyzedTikTokUsers caps
 * each pass at 500 users, so loop until none remain (bounded) — this lets a
 * single trigger fully backfill a large ingest.
 */
async function classifyAllUnanalyzedTikTokUsers(launchedBy: string | null = null): Promise<void> {
  for (let pass = 0; pass < 20; pass++) {
    await classifyUnanalyzedTikTokUsers(launchedBy);
    if ((await countUnanalyzedTikTokUsers()) === 0) break;
  }
}

router.get("/tiktok/dashboard", async (_req, res): Promise<void> => {
  const [[userCount], [postCount], [commentCount], [analysisCount], [analyzedUserCount], [activeJobCount]] =
    await Promise.all([
      db.select({ count: count() }).from(tiktokUsersTable),
      // TikTok posts aren't stored in tiktok_posts (the comment-scraper
      // returns comments, not posts), so "Posts Analyzed" reflects the distinct
      // TikTok post URLs run through topic sentiment analysis.
      db
        .select({ count: sql<number>`COUNT(DISTINCT ${topicAnalysisPostsTable.url})` })
        .from(topicAnalysisPostsTable)
        .where(ilike(topicAnalysisPostsTable.url, "%tiktok.com%")),
      db.select({ count: count() }).from(tiktokCommentsTable),
      db.select({ count: count() }).from(tiktokAnalysesTable),
      db.select({ count: sql<number>`COUNT(DISTINCT ${tiktokAnalysesTable.userId})` }).from(tiktokAnalysesTable),
      db.select({ count: count() }).from(jobsTable).where(sql`status IN ('pending', 'running')`),
    ]);

  const totalUsers = Number(userCount?.count ?? 0);
  const analyzedUsers = Number(analyzedUserCount?.count ?? 0);
  const unanalyzedUsers = Math.max(0, totalUsers - analyzedUsers);

  const archetypeDistribution = await db
    .select({
      archetypeKey: tiktokArchetypeScoresTable.archetypeKey,
      archetypeName: tiktokArchetypeScoresTable.archetypeName,
      userCount: sql<number>`COUNT(DISTINCT ${tiktokArchetypeScoresTable.userId})`,
    })
    .from(tiktokArchetypeScoresTable)
    .where(
      and(
        gt(tiktokArchetypeScoresTable.score, 40),
        eq(tiktokArchetypeScoresTable.isLatest, true),
        sql`${tiktokArchetypeScoresTable.archetypeKey} != 'mixed_unclassified'`,
      ),
    )
    .groupBy(tiktokArchetypeScoresTable.archetypeKey, tiktokArchetypeScoresTable.archetypeName)
    .orderBy(desc(sql`COUNT(DISTINCT ${tiktokArchetypeScoresTable.userId})`))
    .limit(10);

  const totalUsersWithScores = archetypeDistribution.reduce((sum, a) => sum + Number(a.userCount), 0) || 1;
  const archetypeDistributionWithPct = archetypeDistribution.map((a) => ({
    archetypeKey: a.archetypeKey,
    archetypeName: a.archetypeName,
    userCount: Number(a.userCount),
    percentage: Math.round((Number(a.userCount) / totalUsersWithScores) * 100),
  }));

  const activityByDay = await db.execute<{ date: string; posts: number; comments: number }>(
    sql`
      SELECT
        date_trunc('day', posted_at)::date::text AS date,
        0 AS posts,
        COUNT(*) AS comments
      FROM tiktok_comments
      WHERE posted_at > NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
      LIMIT 30
    `,
  );

  const topUsersRaw = await db
    .select({
      id: tiktokUsersTable.id,
      username: tiktokUsersTable.username,
      displayName: tiktokUsersTable.displayName,
      profileUrl: tiktokUsersTable.profileUrl,
      firstSeen: tiktokUsersTable.firstSeen,
      lastSeen: tiktokUsersTable.lastSeen,
      totalComments: tiktokUsersTable.totalComments,
      totalPosts: tiktokUsersTable.totalPosts,
      topScore: sql<number>`MAX(${tiktokArchetypeScoresTable.score})`,
      dominantArchetype: sql<string>`(array_agg(${tiktokArchetypeScoresTable.archetypeName} ORDER BY ${tiktokArchetypeScoresTable.score} DESC))[1]`,
    })
    .from(tiktokUsersTable)
    .leftJoin(
      tiktokArchetypeScoresTable,
      and(eq(tiktokArchetypeScoresTable.userId, tiktokUsersTable.id), eq(tiktokArchetypeScoresTable.isLatest, true)),
    )
    .groupBy(tiktokUsersTable.id)
    .having(
      sql`(array_agg(${tiktokArchetypeScoresTable.archetypeKey} ORDER BY ${tiktokArchetypeScoresTable.score} DESC))[1] != 'mixed_unclassified'`,
    )
    .orderBy(desc(sql`MAX(${tiktokArchetypeScoresTable.score})`))
    .limit(10);

  const topUsers = topUsersRaw.map((u) => ({
    user: serializeUser(u),
    dominantArchetype: u.dominantArchetype ?? null,
    topScore: u.topScore ? Number(u.topScore) : null,
    analysisCount: 0,
  }));

  const topThemesRaw = await db.execute<{ theme: string; count: number }>(
    sql`
      SELECT theme, COUNT(*) AS count
      FROM (
        SELECT unnest(theme_labels) AS theme
        FROM tiktok_analyses
        WHERE is_latest
      ) t
      WHERE theme NOT IN ('Insufficient Data', 'N/A', '')
      GROUP BY theme
      ORDER BY count DESC
      LIMIT 10
    `,
  );

  res.json({
    totalUsers,
    totalPosts: Number(postCount?.count ?? 0),
    totalComments: Number(commentCount?.count ?? 0),
    totalAnalyses: Number(analysisCount?.count ?? 0),
    analyzedUsers,
    unanalyzedUsers,
    activeJobs: Number(activeJobCount?.count ?? 0),
    archetypeDistribution: archetypeDistributionWithPct,
    activityByDay: (activityByDay.rows ?? []).map((r) => ({
      date: r.date,
      posts: Number(r.posts),
      comments: Number(r.comments),
    })),
    topUsers,
    topThemes: (topThemesRaw.rows ?? []).map((r) => ({ theme: r.theme, count: Number(r.count) })),
  });
});

router.get("/tiktok/dashboard/theme-details", async (req, res): Promise<void> => {
  const label = typeof req.query.label === "string" ? req.query.label : null;
  if (!label) {
    res.status(400).json({ error: "label query param required" });
    return;
  }

  const rows = await db.execute<{ username: string; display_name: string; description: string }>(
    sql`
      SELECT iu.username,
             iu.display_name,
             (a.recurring_themes)[array_position(a.theme_labels, ${label})] AS description
      FROM tiktok_analyses a
      JOIN tiktok_users iu ON iu.id = a.user_id
      WHERE ${label} = ANY(a.theme_labels)
        AND a.is_latest
        AND (a.recurring_themes)[array_position(a.theme_labels, ${label})] IS NOT NULL
      ORDER BY iu.display_name
      LIMIT 50
    `,
  );

  res.json({
    label,
    items: (rows.rows ?? []).map((r) => ({
      username: r.username,
      displayName: r.display_name,
      description: r.description,
    })),
  });
});

router.get("/tiktok/users", async (req, res): Promise<void> => {
  const params = ListTikTokUsersQueryParams.safeParse(req.query);
  const limit = params.success && params.data.limit ? params.data.limit : 50;
  const offset = params.success && params.data.offset ? params.data.offset : 0;
  const q = params.success && params.data.q ? params.data.q.trim() : undefined;
  const archetypeFilter = params.success ? params.data.archetype : undefined;
  const minScore = params.success && params.data.minScore != null ? params.data.minScore : undefined;
  const sortBy = params.success && params.data.sortBy ? params.data.sortBy : "recent";

  const conditions = [];
  if (q) {
    // Fuzzy, forgiving search: substring match on the display name OR the
    // TikTok username, plus trigram similarity so close misspellings still
    // surface as suggestions rather than requiring an exact match.
    const like = `%${q}%`;
    conditions.push(
      sql`(${tiktokUsersTable.displayName} ILIKE ${like} OR ${tiktokUsersTable.username} ILIKE ${like} OR similarity(${tiktokUsersTable.displayName}, ${q}) > 0.15)`,
    );
  }
  if (archetypeFilter) {
    const threshold = minScore ?? 1;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${tiktokArchetypeScoresTable} s WHERE s.user_id = ${tiktokUsersTable.id} AND s.is_latest AND s.archetype_key = ${archetypeFilter} AND s.score >= ${threshold})`,
    );
  } else if (minScore != null) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${tiktokArchetypeScoresTable} s WHERE s.user_id = ${tiktokUsersTable.id} AND s.is_latest AND s.score >= ${minScore})`,
    );
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orderByClause = q
    ? // When searching, rank by relevance so the closest matches lead.
      desc(sql`GREATEST(similarity(${tiktokUsersTable.displayName}, ${q}), similarity(${tiktokUsersTable.username}, ${q}))`)
    : sortBy === "name"
      ? tiktokUsersTable.displayName
      : sortBy === "score"
        ? desc(sql`MAX(${tiktokArchetypeScoresTable.score})`)
        : sortBy === "volume"
          ? desc(sql`(${tiktokUsersTable.totalPosts} + ${tiktokUsersTable.totalComments})`)
          : desc(tiktokUsersTable.lastSeen);

  const usersRaw = await db
    .select({
      id: tiktokUsersTable.id,
      username: tiktokUsersTable.username,
      displayName: tiktokUsersTable.displayName,
      profileUrl: tiktokUsersTable.profileUrl,
      firstSeen: tiktokUsersTable.firstSeen,
      lastSeen: tiktokUsersTable.lastSeen,
      totalComments: tiktokUsersTable.totalComments,
      totalPosts: tiktokUsersTable.totalPosts,
      dominantArchetype: sql<string>`(array_agg(${tiktokArchetypeScoresTable.archetypeName} ORDER BY ${tiktokArchetypeScoresTable.score} DESC))[1]`,
      topScore: sql<number>`MAX(${tiktokArchetypeScoresTable.score})`,
      analysisCount: sql<number>`(SELECT COUNT(*) FROM ${tiktokAnalysesTable} a WHERE a.user_id = ${tiktokUsersTable.id})`,
    })
    .from(tiktokUsersTable)
    .leftJoin(
      tiktokArchetypeScoresTable,
      and(eq(tiktokArchetypeScoresTable.userId, tiktokUsersTable.id), eq(tiktokArchetypeScoresTable.isLatest, true)),
    )
    .where(whereClause)
    .groupBy(tiktokUsersTable.id)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const [totalResult] = await db.select({ count: count() }).from(tiktokUsersTable).where(whereClause);

  const users = usersRaw.map((u) => ({
    user: serializeUser(u),
    dominantArchetype: u.dominantArchetype ?? null,
    topScore: u.topScore ? Number(u.topScore) : null,
    analysisCount: Number(u.analysisCount ?? 0),
  }));

  res.json({ users, total: Number(totalResult?.count ?? 0) });
});

router.get("/tiktok/users/:username", async (req, res): Promise<void> => {
  const username = req.params.username;

  const [user] = await db
    .select()
    .from(tiktokUsersTable)
    .where(eq(tiktokUsersTable.username, username));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const latestAnalysis = await db
    .select()
    .from(tiktokAnalysesTable)
    .where(eq(tiktokAnalysesTable.userId, user.id))
    .orderBy(desc(tiktokAnalysesTable.createdAt))
    .limit(1);

  const archetypeScores = latestAnalysis[0]
    ? await db
        .select()
        .from(tiktokArchetypeScoresTable)
        .where(eq(tiktokArchetypeScoresTable.analysisId, latestAnalysis[0].id))
        .orderBy(desc(tiktokArchetypeScoresTable.score))
    : [];

  const recentComments = await db
    .select({
      id: tiktokCommentsTable.id,
      body: tiktokCommentsTable.body,
      likes: tiktokCommentsTable.likes,
      createdAt: tiktokCommentsTable.createdAt,
      commentUrl: tiktokCommentsTable.commentUrl,
    })
    .from(tiktokCommentsTable)
    .where(eq(tiktokCommentsTable.authorUsername, user.username))
    .orderBy(desc(tiktokCommentsTable.createdAt));

  const analysis = latestAnalysis[0];
  const scores = archetypeScores.map((s) => ({
    archetypeKey: s.archetypeKey,
    archetypeName: s.archetypeName,
    score: s.score,
    confidence: s.confidence,
    explanation: s.explanation ?? null,
    evidence: s.evidence,
  }));

  res.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      profileUrl: user.profileUrl ?? null,
      firstSeen: user.firstSeen?.toISOString() ?? null,
      lastSeen: user.lastSeen?.toISOString() ?? null,
      totalComments: user.totalComments,
      totalPosts: user.totalPosts,
      notes: user.notes ?? null,
    },
    latestAnalysis: analysis
      ? {
          id: analysis.id,
          createdAt: analysis.createdAt.toISOString(),
          dominantArchetypes: analysis.dominantArchetypes,
          summary: analysis.summary,
          recurringThemes: analysis.recurringThemes,
          confidenceNotes: analysis.confidenceNotes,
          archetypeScores: scores,
        }
      : null,
    archetypeScores: scores,
    recentComments: recentComments.map((c) => ({
      id: c.id,
      body: c.body,
      likes: c.likes,
      createdAt: c.createdAt.toISOString(),
      commentUrl: c.commentUrl ?? null,
    })),
  });
});

router.get("/tiktok/archetypes", async (_req, res): Promise<void> => {
  const statsRaw = await db
    .select({
      archetypeKey: tiktokArchetypeScoresTable.archetypeKey,
      archetypeName: tiktokArchetypeScoresTable.archetypeName,
      userCount: sql<number>`COUNT(DISTINCT ${tiktokArchetypeScoresTable.userId})`,
      averageScore: sql<number>`AVG(${tiktokArchetypeScoresTable.score})`,
    })
    .from(tiktokArchetypeScoresTable)
    .where(and(gt(tiktokArchetypeScoresTable.score, 30), eq(tiktokArchetypeScoresTable.isLatest, true)))
    .groupBy(tiktokArchetypeScoresTable.archetypeKey, tiktokArchetypeScoresTable.archetypeName);

  const statsMap = Object.fromEntries(statsRaw.map((s) => [s.archetypeKey, s]));

  const topThemesRaw = await db.execute<{ archetype_key: string; theme: string; cnt: number }>(
    sql`
      SELECT aks.archetype_key, unnest(a.recurring_themes) AS theme, COUNT(*) AS cnt
      FROM tiktok_archetype_scores aks
      JOIN tiktok_analyses a ON a.id = aks.analysis_id
      WHERE aks.score > 30 AND aks.is_latest
      GROUP BY aks.archetype_key, theme
      ORDER BY cnt DESC
    `,
  );

  const themesByArchetype: Record<string, string[]> = {};
  for (const row of topThemesRaw.rows ?? []) {
    const key = row.archetype_key;
    if (!themesByArchetype[key]) themesByArchetype[key] = [];
    if (themesByArchetype[key].length < 5) themesByArchetype[key].push(row.theme);
  }

  const result = ARCHETYPES.map((a) => {
    const stats = statsMap[a.key];
    return {
      key: a.key,
      name: a.name,
      description: a.description,
      indicators: [...a.indicators],
      userCount: stats ? Number(stats.userCount) : 0,
      averageScore: stats ? Math.round(Number(stats.averageScore)) : 0,
      topThemes: themesByArchetype[a.key] ?? [],
      relatedArchetypes: [...a.relatedArchetypes],
    };
  });

  res.json(result);
});

router.get("/tiktok/archetypes/:key/users", async (req, res): Promise<void> => {
  const pathParams = GetTikTokArchetypeUsersParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }

  const queryParams = GetTikTokArchetypeUsersQueryParams.safeParse(req.query);
  const minScore = queryParams.success && queryParams.data.minScore != null ? queryParams.data.minScore : 1;
  const limit = queryParams.success && queryParams.data.limit != null ? queryParams.data.limit : 100;

  // Dedupe per user: take each user's highest score for this archetype rather
  // than one row per analysis.
  const usersRaw = await db
    .select({
      id: tiktokUsersTable.id,
      username: tiktokUsersTable.username,
      displayName: tiktokUsersTable.displayName,
      profileUrl: tiktokUsersTable.profileUrl,
      firstSeen: tiktokUsersTable.firstSeen,
      lastSeen: tiktokUsersTable.lastSeen,
      totalComments: tiktokUsersTable.totalComments,
      totalPosts: tiktokUsersTable.totalPosts,
      score: sql<number>`MAX(${tiktokArchetypeScoresTable.score})`,
    })
    .from(tiktokArchetypeScoresTable)
    .innerJoin(tiktokUsersTable, eq(tiktokUsersTable.id, tiktokArchetypeScoresTable.userId))
    .where(
      and(
        sql`${tiktokArchetypeScoresTable.archetypeKey} = ${pathParams.data.key}`,
        eq(tiktokArchetypeScoresTable.isLatest, true),
      ),
    )
    .groupBy(tiktokUsersTable.id)
    .having(sql`MAX(${tiktokArchetypeScoresTable.score}) >= ${minScore}`)
    .orderBy(desc(sql`MAX(${tiktokArchetypeScoresTable.score})`))
    .limit(limit);

  res.json(
    usersRaw.map((u) => ({
      user: serializeUser(u),
      dominantArchetype: pathParams.data.key,
      topScore: u.score ? Number(u.score) : null,
      analysisCount: 1,
    })),
  );
});

router.get("/tiktok/search", async (req, res): Promise<void> => {
  const params = SearchTikTokUsersQueryParams.safeParse(req.query);
  const q = params.success ? params.data.q : undefined;
  const archetype = params.success ? params.data.archetype : undefined;
  const minScore = params.success && params.data.minScore != null ? params.data.minScore : 0;
  const limit = params.success && params.data.limit != null ? params.data.limit : 50;

  if (archetype) {
    const results = await db
      .select({
        id: tiktokUsersTable.id,
        username: tiktokUsersTable.username,
        displayName: tiktokUsersTable.displayName,
        profileUrl: tiktokUsersTable.profileUrl,
        firstSeen: tiktokUsersTable.firstSeen,
        lastSeen: tiktokUsersTable.lastSeen,
        totalComments: tiktokUsersTable.totalComments,
        totalPosts: tiktokUsersTable.totalPosts,
        topScore: tiktokArchetypeScoresTable.score,
        dominantArchetype: tiktokArchetypeScoresTable.archetypeName,
      })
      .from(tiktokArchetypeScoresTable)
      .innerJoin(tiktokUsersTable, eq(tiktokUsersTable.id, tiktokArchetypeScoresTable.userId))
      .where(
        and(
          sql`${tiktokArchetypeScoresTable.archetypeKey} = ${archetype}`,
          eq(tiktokArchetypeScoresTable.isLatest, true),
          sql`${tiktokArchetypeScoresTable.score} >= ${minScore}`,
          q ? ilike(tiktokUsersTable.displayName, `%${q}%`) : undefined,
        ),
      )
      .orderBy(desc(tiktokArchetypeScoresTable.score))
      .limit(limit);

    res.json(
      results.map((r) => ({
        user: serializeUser(r),
        dominantArchetype: r.dominantArchetype ?? null,
        topScore: r.topScore ? Number(r.topScore) : null,
        analysisCount: 1,
      })),
    );
    return;
  }

  const results = await db
    .select({
      id: tiktokUsersTable.id,
      username: tiktokUsersTable.username,
      displayName: tiktokUsersTable.displayName,
      profileUrl: tiktokUsersTable.profileUrl,
      firstSeen: tiktokUsersTable.firstSeen,
      lastSeen: tiktokUsersTable.lastSeen,
      totalComments: tiktokUsersTable.totalComments,
      totalPosts: tiktokUsersTable.totalPosts,
      topScore: sql<number>`MAX(${tiktokArchetypeScoresTable.score})`,
      dominantArchetype: sql<string>`(array_agg(${tiktokArchetypeScoresTable.archetypeName} ORDER BY ${tiktokArchetypeScoresTable.score} DESC))[1]`,
    })
    .from(tiktokUsersTable)
    .leftJoin(
      tiktokArchetypeScoresTable,
      and(eq(tiktokArchetypeScoresTable.userId, tiktokUsersTable.id), eq(tiktokArchetypeScoresTable.isLatest, true)),
    )
    .where(q ? ilike(tiktokUsersTable.displayName, `%${q}%`) : undefined)
    .groupBy(tiktokUsersTable.id)
    .orderBy(desc(tiktokUsersTable.lastSeen))
    .limit(limit);

  res.json(
    results.map((r) => ({
      user: serializeUser(r),
      dominantArchetype: r.dominantArchetype ?? null,
      topScore: r.topScore ? Number(r.topScore) : null,
      analysisCount: 0,
    })),
  );
});

router.post("/tiktok/classify", async (req, res): Promise<void> => {
  if (await isTikTokClassificationRunning()) {
    res.status(200).json({ status: "already_running", pending: 0 });
    return;
  }

  const pending = await countUnanalyzedTikTokUsers();
  if (pending === 0) {
    res.status(200).json({ status: "nothing_to_do", pending: 0 });
    return;
  }

  classifyAllUnanalyzedTikTokUsers(req.session.user ?? null).catch((err) => {
    logger.error({ err }, "TikTok classification backfill failed");
  });

  res.status(202).json({ status: "started", pending });
});

interface TikTokUserRow {
  id: number;
  username: string;
  displayName: string;
  profileUrl: string | null;
  firstSeen: Date | null;
  lastSeen: Date | null;
  totalComments: number;
  totalPosts: number;
}

function serializeUser(u: TikTokUserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    profileUrl: u.profileUrl ?? null,
    firstSeen: u.firstSeen?.toISOString() ?? null,
    lastSeen: u.lastSeen?.toISOString() ?? null,
    totalComments: u.totalComments,
    totalPosts: u.totalPosts,
  };
}

export default router;
