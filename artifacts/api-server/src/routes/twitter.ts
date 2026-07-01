import { Router, type IRouter } from "express";
import {
  db,
  twitterUsersTable,
  twitterCommentsTable,
  twitterAnalysesTable,
  twitterArchetypeScoresTable,
  jobsTable,
  topicAnalysisPostsTable,
} from "@workspace/db";
import { sql, count, eq, desc, gt, and, ilike } from "drizzle-orm";
import {
  ListTwitterUsersQueryParams,
  SearchTwitterUsersQueryParams,
  GetTwitterArchetypeUsersParams,
  GetTwitterArchetypeUsersQueryParams,
} from "@workspace/api-zod";
import { ARCHETYPES } from "../lib/archetypes";
import { classifyUnanalyzedTwitterUsers } from "../lib/twitter-classify";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** True if an Twitter classification batch is currently running. */
async function isTwitterClassificationRunning(): Promise<boolean> {
  const [running] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(eq(jobsTable.jobType, "analyze_twitter_batch"), eq(jobsTable.status, "running")))
    .limit(1);
  return Boolean(running);
}

/**
 * Count Twitter users that have ingested content but no current analysis (or
 * new content since their latest one). Mirrors the targeting in
 * classifyUnanalyzedTwitterUsers so the /twitter/classify gate stays accurate.
 */
async function countUnanalyzedTwitterUsers(): Promise<number> {
  const rows = await db.execute<{ count: number }>(
    sql`
      SELECT COUNT(*)::int AS count
      FROM twitter_users u
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_at FROM twitter_analyses WHERE user_id = u.id
      ) la ON TRUE
      WHERE la.last_at IS NULL
         OR EXISTS (
           SELECT 1 FROM twitter_comments c
           WHERE c.author_username = u.username AND c.created_at > la.last_at
         )
    `,
  );
  return Number(rows.rows?.[0]?.count ?? 0);
}

/**
 * Classify every unanalyzed Twitter user. classifyUnanalyzedTwitterUsers caps
 * each pass at 500 users, so loop until none remain (bounded) — this lets a
 * single trigger fully backfill a large ingest.
 */
async function classifyAllUnanalyzedTwitterUsers(launchedBy: string | null = null): Promise<void> {
  for (let pass = 0; pass < 20; pass++) {
    await classifyUnanalyzedTwitterUsers(launchedBy);
    if ((await countUnanalyzedTwitterUsers()) === 0) break;
  }
}

router.get("/twitter/dashboard", async (_req, res): Promise<void> => {
  const [[userCount], [postCount], [commentCount], [analysisCount], [analyzedUserCount], [activeJobCount]] =
    await Promise.all([
      db.select({ count: count() }).from(twitterUsersTable),
      // Twitter posts aren't stored in twitter_posts (the comment-scraper
      // returns comments, not posts), so "Posts Analyzed" reflects the distinct
      // Twitter post URLs run through topic sentiment analysis.
      db
        .select({ count: sql<number>`COUNT(DISTINCT ${topicAnalysisPostsTable.url})` })
        .from(topicAnalysisPostsTable)
        .where(
          sql`(${topicAnalysisPostsTable.url} ILIKE '%x.com%' OR ${topicAnalysisPostsTable.url} ILIKE '%twitter.com%')`,
        ),
      db.select({ count: count() }).from(twitterCommentsTable),
      db.select({ count: count() }).from(twitterAnalysesTable),
      db.select({ count: sql<number>`COUNT(DISTINCT ${twitterAnalysesTable.userId})` }).from(twitterAnalysesTable),
      db.select({ count: count() }).from(jobsTable).where(sql`status IN ('pending', 'running')`),
    ]);

  const totalUsers = Number(userCount?.count ?? 0);
  const analyzedUsers = Number(analyzedUserCount?.count ?? 0);
  const unanalyzedUsers = Math.max(0, totalUsers - analyzedUsers);

  const archetypeDistribution = await db
    .select({
      archetypeKey: twitterArchetypeScoresTable.archetypeKey,
      archetypeName: twitterArchetypeScoresTable.archetypeName,
      userCount: sql<number>`COUNT(DISTINCT ${twitterArchetypeScoresTable.userId})`,
    })
    .from(twitterArchetypeScoresTable)
    .where(
      and(
        gt(twitterArchetypeScoresTable.score, 40),
        eq(twitterArchetypeScoresTable.isLatest, true),
        sql`${twitterArchetypeScoresTable.archetypeKey} != 'mixed_unclassified'`,
      ),
    )
    .groupBy(twitterArchetypeScoresTable.archetypeKey, twitterArchetypeScoresTable.archetypeName)
    .orderBy(desc(sql`COUNT(DISTINCT ${twitterArchetypeScoresTable.userId})`))
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
      FROM twitter_comments
      WHERE posted_at > NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
      LIMIT 30
    `,
  );

  const topUsersRaw = await db
    .select({
      id: twitterUsersTable.id,
      username: twitterUsersTable.username,
      displayName: twitterUsersTable.displayName,
      profileUrl: twitterUsersTable.profileUrl,
      firstSeen: twitterUsersTable.firstSeen,
      lastSeen: twitterUsersTable.lastSeen,
      totalComments: twitterUsersTable.totalComments,
      totalPosts: twitterUsersTable.totalPosts,
      topScore: sql<number>`MAX(${twitterArchetypeScoresTable.score})`,
      dominantArchetype: sql<string>`(array_agg(${twitterArchetypeScoresTable.archetypeName} ORDER BY ${twitterArchetypeScoresTable.score} DESC))[1]`,
    })
    .from(twitterUsersTable)
    .leftJoin(
      twitterArchetypeScoresTable,
      and(eq(twitterArchetypeScoresTable.userId, twitterUsersTable.id), eq(twitterArchetypeScoresTable.isLatest, true)),
    )
    .groupBy(twitterUsersTable.id)
    .having(
      sql`(array_agg(${twitterArchetypeScoresTable.archetypeKey} ORDER BY ${twitterArchetypeScoresTable.score} DESC))[1] != 'mixed_unclassified'`,
    )
    .orderBy(desc(sql`MAX(${twitterArchetypeScoresTable.score})`))
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
        FROM twitter_analyses
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

router.get("/twitter/dashboard/theme-details", async (req, res): Promise<void> => {
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
      FROM twitter_analyses a
      JOIN twitter_users iu ON iu.id = a.user_id
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

router.get("/twitter/users", async (req, res): Promise<void> => {
  const params = ListTwitterUsersQueryParams.safeParse(req.query);
  const limit = params.success && params.data.limit ? params.data.limit : 50;
  const offset = params.success && params.data.offset ? params.data.offset : 0;
  const q = params.success && params.data.q ? params.data.q.trim() : undefined;
  const archetypeFilter = params.success ? params.data.archetype : undefined;
  const minScore = params.success && params.data.minScore != null ? params.data.minScore : undefined;
  const sortBy = params.success && params.data.sortBy ? params.data.sortBy : "recent";

  const conditions = [];
  if (q) {
    // Fuzzy, forgiving search: substring match on the display name OR the
    // Twitter username, plus trigram similarity so close misspellings still
    // surface as suggestions rather than requiring an exact match.
    const like = `%${q}%`;
    conditions.push(
      sql`(${twitterUsersTable.displayName} ILIKE ${like} OR ${twitterUsersTable.username} ILIKE ${like} OR similarity(${twitterUsersTable.displayName}, ${q}) > 0.15)`,
    );
  }
  if (archetypeFilter) {
    const threshold = minScore ?? 1;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${twitterArchetypeScoresTable} s WHERE s.user_id = ${twitterUsersTable.id} AND s.is_latest AND s.archetype_key = ${archetypeFilter} AND s.score >= ${threshold})`,
    );
  } else if (minScore != null) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${twitterArchetypeScoresTable} s WHERE s.user_id = ${twitterUsersTable.id} AND s.is_latest AND s.score >= ${minScore})`,
    );
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orderByClause = q
    ? // When searching, rank by relevance so the closest matches lead.
      desc(sql`GREATEST(similarity(${twitterUsersTable.displayName}, ${q}), similarity(${twitterUsersTable.username}, ${q}))`)
    : sortBy === "name"
      ? twitterUsersTable.displayName
      : sortBy === "score"
        ? desc(sql`MAX(${twitterArchetypeScoresTable.score})`)
        : sortBy === "volume"
          ? desc(sql`(${twitterUsersTable.totalPosts} + ${twitterUsersTable.totalComments})`)
          : desc(twitterUsersTable.lastSeen);

  const usersRaw = await db
    .select({
      id: twitterUsersTable.id,
      username: twitterUsersTable.username,
      displayName: twitterUsersTable.displayName,
      profileUrl: twitterUsersTable.profileUrl,
      firstSeen: twitterUsersTable.firstSeen,
      lastSeen: twitterUsersTable.lastSeen,
      totalComments: twitterUsersTable.totalComments,
      totalPosts: twitterUsersTable.totalPosts,
      dominantArchetype: sql<string>`(array_agg(${twitterArchetypeScoresTable.archetypeName} ORDER BY ${twitterArchetypeScoresTable.score} DESC))[1]`,
      topScore: sql<number>`MAX(${twitterArchetypeScoresTable.score})`,
      analysisCount: sql<number>`(SELECT COUNT(*) FROM ${twitterAnalysesTable} a WHERE a.user_id = ${twitterUsersTable.id})`,
    })
    .from(twitterUsersTable)
    .leftJoin(
      twitterArchetypeScoresTable,
      and(eq(twitterArchetypeScoresTable.userId, twitterUsersTable.id), eq(twitterArchetypeScoresTable.isLatest, true)),
    )
    .where(whereClause)
    .groupBy(twitterUsersTable.id)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const [totalResult] = await db.select({ count: count() }).from(twitterUsersTable).where(whereClause);

  const users = usersRaw.map((u) => ({
    user: serializeUser(u),
    dominantArchetype: u.dominantArchetype ?? null,
    topScore: u.topScore ? Number(u.topScore) : null,
    analysisCount: Number(u.analysisCount ?? 0),
  }));

  res.json({ users, total: Number(totalResult?.count ?? 0) });
});

router.get("/twitter/users/:username", async (req, res): Promise<void> => {
  const username = req.params.username;

  const [user] = await db
    .select()
    .from(twitterUsersTable)
    .where(eq(twitterUsersTable.username, username));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const latestAnalysis = await db
    .select()
    .from(twitterAnalysesTable)
    .where(eq(twitterAnalysesTable.userId, user.id))
    .orderBy(desc(twitterAnalysesTable.createdAt))
    .limit(1);

  const archetypeScores = latestAnalysis[0]
    ? await db
        .select()
        .from(twitterArchetypeScoresTable)
        .where(eq(twitterArchetypeScoresTable.analysisId, latestAnalysis[0].id))
        .orderBy(desc(twitterArchetypeScoresTable.score))
    : [];

  const recentComments = await db
    .select({
      id: twitterCommentsTable.id,
      body: twitterCommentsTable.body,
      likes: twitterCommentsTable.likes,
      createdAt: twitterCommentsTable.createdAt,
      commentUrl: twitterCommentsTable.commentUrl,
    })
    .from(twitterCommentsTable)
    .where(eq(twitterCommentsTable.authorUsername, user.username))
    .orderBy(desc(twitterCommentsTable.createdAt));

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

router.get("/twitter/archetypes", async (_req, res): Promise<void> => {
  const statsRaw = await db
    .select({
      archetypeKey: twitterArchetypeScoresTable.archetypeKey,
      archetypeName: twitterArchetypeScoresTable.archetypeName,
      userCount: sql<number>`COUNT(DISTINCT ${twitterArchetypeScoresTable.userId})`,
      averageScore: sql<number>`AVG(${twitterArchetypeScoresTable.score})`,
    })
    .from(twitterArchetypeScoresTable)
    .where(and(gt(twitterArchetypeScoresTable.score, 30), eq(twitterArchetypeScoresTable.isLatest, true)))
    .groupBy(twitterArchetypeScoresTable.archetypeKey, twitterArchetypeScoresTable.archetypeName);

  const statsMap = Object.fromEntries(statsRaw.map((s) => [s.archetypeKey, s]));

  const topThemesRaw = await db.execute<{ archetype_key: string; theme: string; cnt: number }>(
    sql`
      SELECT aks.archetype_key, unnest(a.recurring_themes) AS theme, COUNT(*) AS cnt
      FROM twitter_archetype_scores aks
      JOIN twitter_analyses a ON a.id = aks.analysis_id
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

router.get("/twitter/archetypes/:key/users", async (req, res): Promise<void> => {
  const pathParams = GetTwitterArchetypeUsersParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }

  const queryParams = GetTwitterArchetypeUsersQueryParams.safeParse(req.query);
  const minScore = queryParams.success && queryParams.data.minScore != null ? queryParams.data.minScore : 1;
  const limit = queryParams.success && queryParams.data.limit != null ? queryParams.data.limit : 100;

  // Dedupe per user: take each user's highest score for this archetype rather
  // than one row per analysis.
  const usersRaw = await db
    .select({
      id: twitterUsersTable.id,
      username: twitterUsersTable.username,
      displayName: twitterUsersTable.displayName,
      profileUrl: twitterUsersTable.profileUrl,
      firstSeen: twitterUsersTable.firstSeen,
      lastSeen: twitterUsersTable.lastSeen,
      totalComments: twitterUsersTable.totalComments,
      totalPosts: twitterUsersTable.totalPosts,
      score: sql<number>`MAX(${twitterArchetypeScoresTable.score})`,
    })
    .from(twitterArchetypeScoresTable)
    .innerJoin(twitterUsersTable, eq(twitterUsersTable.id, twitterArchetypeScoresTable.userId))
    .where(
      and(
        sql`${twitterArchetypeScoresTable.archetypeKey} = ${pathParams.data.key}`,
        eq(twitterArchetypeScoresTable.isLatest, true),
      ),
    )
    .groupBy(twitterUsersTable.id)
    .having(sql`MAX(${twitterArchetypeScoresTable.score}) >= ${minScore}`)
    .orderBy(desc(sql`MAX(${twitterArchetypeScoresTable.score})`))
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

router.get("/twitter/search", async (req, res): Promise<void> => {
  const params = SearchTwitterUsersQueryParams.safeParse(req.query);
  const q = params.success ? params.data.q : undefined;
  const archetype = params.success ? params.data.archetype : undefined;
  const minScore = params.success && params.data.minScore != null ? params.data.minScore : 0;
  const limit = params.success && params.data.limit != null ? params.data.limit : 50;

  if (archetype) {
    const results = await db
      .select({
        id: twitterUsersTable.id,
        username: twitterUsersTable.username,
        displayName: twitterUsersTable.displayName,
        profileUrl: twitterUsersTable.profileUrl,
        firstSeen: twitterUsersTable.firstSeen,
        lastSeen: twitterUsersTable.lastSeen,
        totalComments: twitterUsersTable.totalComments,
        totalPosts: twitterUsersTable.totalPosts,
        topScore: twitterArchetypeScoresTable.score,
        dominantArchetype: twitterArchetypeScoresTable.archetypeName,
      })
      .from(twitterArchetypeScoresTable)
      .innerJoin(twitterUsersTable, eq(twitterUsersTable.id, twitterArchetypeScoresTable.userId))
      .where(
        and(
          sql`${twitterArchetypeScoresTable.archetypeKey} = ${archetype}`,
          eq(twitterArchetypeScoresTable.isLatest, true),
          sql`${twitterArchetypeScoresTable.score} >= ${minScore}`,
          q ? ilike(twitterUsersTable.displayName, `%${q}%`) : undefined,
        ),
      )
      .orderBy(desc(twitterArchetypeScoresTable.score))
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
      id: twitterUsersTable.id,
      username: twitterUsersTable.username,
      displayName: twitterUsersTable.displayName,
      profileUrl: twitterUsersTable.profileUrl,
      firstSeen: twitterUsersTable.firstSeen,
      lastSeen: twitterUsersTable.lastSeen,
      totalComments: twitterUsersTable.totalComments,
      totalPosts: twitterUsersTable.totalPosts,
      topScore: sql<number>`MAX(${twitterArchetypeScoresTable.score})`,
      dominantArchetype: sql<string>`(array_agg(${twitterArchetypeScoresTable.archetypeName} ORDER BY ${twitterArchetypeScoresTable.score} DESC))[1]`,
    })
    .from(twitterUsersTable)
    .leftJoin(
      twitterArchetypeScoresTable,
      and(eq(twitterArchetypeScoresTable.userId, twitterUsersTable.id), eq(twitterArchetypeScoresTable.isLatest, true)),
    )
    .where(q ? ilike(twitterUsersTable.displayName, `%${q}%`) : undefined)
    .groupBy(twitterUsersTable.id)
    .orderBy(desc(twitterUsersTable.lastSeen))
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

router.post("/twitter/classify", async (req, res): Promise<void> => {
  if (await isTwitterClassificationRunning()) {
    res.status(200).json({ status: "already_running", pending: 0 });
    return;
  }

  const pending = await countUnanalyzedTwitterUsers();
  if (pending === 0) {
    res.status(200).json({ status: "nothing_to_do", pending: 0 });
    return;
  }

  classifyAllUnanalyzedTwitterUsers(req.session.user ?? null).catch((err) => {
    logger.error({ err }, "Twitter classification backfill failed");
  });

  res.status(202).json({ status: "started", pending });
});

interface TwitterUserRow {
  id: number;
  username: string;
  displayName: string;
  profileUrl: string | null;
  firstSeen: Date | null;
  lastSeen: Date | null;
  totalComments: number;
  totalPosts: number;
}

function serializeUser(u: TwitterUserRow) {
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
