import { Router, type IRouter } from "express";
import {
  db,
  youtubeUsersTable,
  youtubeCommentsTable,
  youtubeAnalysesTable,
  youtubeArchetypeScoresTable,
  jobsTable,
  topicAnalysisPostsTable,
} from "@workspace/db";
import { sql, count, eq, desc, gt, and, ilike } from "drizzle-orm";
import {
  ListYoutubeUsersQueryParams,
  SearchYoutubeUsersQueryParams,
  GetYoutubeArchetypeUsersParams,
  GetYoutubeArchetypeUsersQueryParams,
} from "@workspace/api-zod";
import { ARCHETYPES } from "../lib/archetypes";
import { classifyUnanalyzedYoutubeUsers } from "../lib/youtube-classify";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** True if an Youtube classification batch is currently running. */
async function isYoutubeClassificationRunning(): Promise<boolean> {
  const [running] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(eq(jobsTable.jobType, "analyze_youtube_batch"), eq(jobsTable.status, "running")))
    .limit(1);
  return Boolean(running);
}

/**
 * Count Youtube users that have ingested content but no current analysis (or
 * new content since their latest one). Mirrors the targeting in
 * classifyUnanalyzedYoutubeUsers so the /youtube/classify gate stays accurate.
 */
async function countUnanalyzedYoutubeUsers(): Promise<number> {
  const rows = await db.execute<{ count: number }>(
    sql`
      SELECT COUNT(*)::int AS count
      FROM youtube_users u
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_at FROM youtube_analyses WHERE user_id = u.id
      ) la ON TRUE
      WHERE la.last_at IS NULL
         OR EXISTS (
           SELECT 1 FROM youtube_comments c
           WHERE c.author_username = u.username AND c.created_at > la.last_at
         )
    `,
  );
  return Number(rows.rows?.[0]?.count ?? 0);
}

/**
 * Classify every unanalyzed Youtube user. classifyUnanalyzedYoutubeUsers caps
 * each pass at 500 users, so loop until none remain (bounded) — this lets a
 * single trigger fully backfill a large ingest.
 */
async function classifyAllUnanalyzedYoutubeUsers(launchedBy: string | null = null): Promise<void> {
  for (let pass = 0; pass < 20; pass++) {
    await classifyUnanalyzedYoutubeUsers(launchedBy);
    if ((await countUnanalyzedYoutubeUsers()) === 0) break;
  }
}

router.get("/youtube/dashboard", async (_req, res): Promise<void> => {
  const [[userCount], [postCount], [commentCount], [analysisCount], [analyzedUserCount], [activeJobCount]] =
    await Promise.all([
      db.select({ count: count() }).from(youtubeUsersTable),
      // Youtube posts aren't stored in youtube_posts (the comment-scraper
      // returns comments, not posts), so "Posts Analyzed" reflects the distinct
      // Youtube post URLs run through topic sentiment analysis.
      db
        .select({ count: sql<number>`COUNT(DISTINCT ${topicAnalysisPostsTable.url})` })
        .from(topicAnalysisPostsTable)
        .where(
          sql`(${topicAnalysisPostsTable.url} ILIKE '%youtube.com%' OR ${topicAnalysisPostsTable.url} ILIKE '%youtu.be%')`,
        ),
      db.select({ count: count() }).from(youtubeCommentsTable),
      db.select({ count: count() }).from(youtubeAnalysesTable),
      db.select({ count: sql<number>`COUNT(DISTINCT ${youtubeAnalysesTable.userId})` }).from(youtubeAnalysesTable),
      db.select({ count: count() }).from(jobsTable).where(sql`status IN ('pending', 'running')`),
    ]);

  const totalUsers = Number(userCount?.count ?? 0);
  const analyzedUsers = Number(analyzedUserCount?.count ?? 0);
  const unanalyzedUsers = Math.max(0, totalUsers - analyzedUsers);

  const archetypeDistribution = await db
    .select({
      archetypeKey: youtubeArchetypeScoresTable.archetypeKey,
      archetypeName: youtubeArchetypeScoresTable.archetypeName,
      userCount: sql<number>`COUNT(DISTINCT ${youtubeArchetypeScoresTable.userId})`,
    })
    .from(youtubeArchetypeScoresTable)
    .where(
      and(
        gt(youtubeArchetypeScoresTable.score, 40),
        eq(youtubeArchetypeScoresTable.isLatest, true),
        sql`${youtubeArchetypeScoresTable.archetypeKey} != 'mixed_unclassified'`,
      ),
    )
    .groupBy(youtubeArchetypeScoresTable.archetypeKey, youtubeArchetypeScoresTable.archetypeName)
    .orderBy(desc(sql`COUNT(DISTINCT ${youtubeArchetypeScoresTable.userId})`))
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
      FROM youtube_comments
      WHERE posted_at > NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
      LIMIT 30
    `,
  );

  const topUsersRaw = await db
    .select({
      id: youtubeUsersTable.id,
      username: youtubeUsersTable.username,
      displayName: youtubeUsersTable.displayName,
      profileUrl: youtubeUsersTable.profileUrl,
      firstSeen: youtubeUsersTable.firstSeen,
      lastSeen: youtubeUsersTable.lastSeen,
      totalComments: youtubeUsersTable.totalComments,
      totalPosts: youtubeUsersTable.totalPosts,
      topScore: sql<number>`MAX(${youtubeArchetypeScoresTable.score})`,
      dominantArchetype: sql<string>`(array_agg(${youtubeArchetypeScoresTable.archetypeName} ORDER BY ${youtubeArchetypeScoresTable.score} DESC))[1]`,
    })
    .from(youtubeUsersTable)
    .leftJoin(
      youtubeArchetypeScoresTable,
      and(eq(youtubeArchetypeScoresTable.userId, youtubeUsersTable.id), eq(youtubeArchetypeScoresTable.isLatest, true)),
    )
    .groupBy(youtubeUsersTable.id)
    .having(
      sql`(array_agg(${youtubeArchetypeScoresTable.archetypeKey} ORDER BY ${youtubeArchetypeScoresTable.score} DESC))[1] != 'mixed_unclassified'`,
    )
    .orderBy(desc(sql`MAX(${youtubeArchetypeScoresTable.score})`))
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
        FROM youtube_analyses
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

router.get("/youtube/dashboard/theme-details", async (req, res): Promise<void> => {
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
      FROM youtube_analyses a
      JOIN youtube_users iu ON iu.id = a.user_id
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

router.get("/youtube/users", async (req, res): Promise<void> => {
  const params = ListYoutubeUsersQueryParams.safeParse(req.query);
  const limit = params.success && params.data.limit ? params.data.limit : 50;
  const offset = params.success && params.data.offset ? params.data.offset : 0;
  const q = params.success && params.data.q ? params.data.q.trim() : undefined;
  const archetypeFilter = params.success ? params.data.archetype : undefined;
  const minScore = params.success && params.data.minScore != null ? params.data.minScore : undefined;
  const sortBy = params.success && params.data.sortBy ? params.data.sortBy : "recent";

  const conditions = [];
  if (q) {
    // Fuzzy, forgiving search: substring match on the display name OR the
    // Youtube username, plus trigram similarity so close misspellings still
    // surface as suggestions rather than requiring an exact match.
    const like = `%${q}%`;
    conditions.push(
      sql`(${youtubeUsersTable.displayName} ILIKE ${like} OR ${youtubeUsersTable.username} ILIKE ${like} OR similarity(${youtubeUsersTable.displayName}, ${q}) > 0.15)`,
    );
  }
  if (archetypeFilter) {
    const threshold = minScore ?? 1;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${youtubeArchetypeScoresTable} s WHERE s.user_id = ${youtubeUsersTable.id} AND s.is_latest AND s.archetype_key = ${archetypeFilter} AND s.score >= ${threshold})`,
    );
  } else if (minScore != null) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${youtubeArchetypeScoresTable} s WHERE s.user_id = ${youtubeUsersTable.id} AND s.is_latest AND s.score >= ${minScore})`,
    );
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orderByClause = q
    ? // When searching, rank by relevance so the closest matches lead.
      desc(sql`GREATEST(similarity(${youtubeUsersTable.displayName}, ${q}), similarity(${youtubeUsersTable.username}, ${q}))`)
    : sortBy === "name"
      ? youtubeUsersTable.displayName
      : sortBy === "score"
        ? desc(sql`MAX(${youtubeArchetypeScoresTable.score})`)
        : sortBy === "volume"
          ? desc(sql`(${youtubeUsersTable.totalPosts} + ${youtubeUsersTable.totalComments})`)
          : desc(youtubeUsersTable.lastSeen);

  const usersRaw = await db
    .select({
      id: youtubeUsersTable.id,
      username: youtubeUsersTable.username,
      displayName: youtubeUsersTable.displayName,
      profileUrl: youtubeUsersTable.profileUrl,
      firstSeen: youtubeUsersTable.firstSeen,
      lastSeen: youtubeUsersTable.lastSeen,
      totalComments: youtubeUsersTable.totalComments,
      totalPosts: youtubeUsersTable.totalPosts,
      dominantArchetype: sql<string>`(array_agg(${youtubeArchetypeScoresTable.archetypeName} ORDER BY ${youtubeArchetypeScoresTable.score} DESC))[1]`,
      topScore: sql<number>`MAX(${youtubeArchetypeScoresTable.score})`,
      analysisCount: sql<number>`(SELECT COUNT(*) FROM ${youtubeAnalysesTable} a WHERE a.user_id = ${youtubeUsersTable.id})`,
    })
    .from(youtubeUsersTable)
    .leftJoin(
      youtubeArchetypeScoresTable,
      and(eq(youtubeArchetypeScoresTable.userId, youtubeUsersTable.id), eq(youtubeArchetypeScoresTable.isLatest, true)),
    )
    .where(whereClause)
    .groupBy(youtubeUsersTable.id)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const [totalResult] = await db.select({ count: count() }).from(youtubeUsersTable).where(whereClause);

  const users = usersRaw.map((u) => ({
    user: serializeUser(u),
    dominantArchetype: u.dominantArchetype ?? null,
    topScore: u.topScore ? Number(u.topScore) : null,
    analysisCount: Number(u.analysisCount ?? 0),
  }));

  res.json({ users, total: Number(totalResult?.count ?? 0) });
});

router.get("/youtube/users/:username", async (req, res): Promise<void> => {
  const username = req.params.username;

  const [user] = await db
    .select()
    .from(youtubeUsersTable)
    .where(eq(youtubeUsersTable.username, username));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const latestAnalysis = await db
    .select()
    .from(youtubeAnalysesTable)
    .where(eq(youtubeAnalysesTable.userId, user.id))
    .orderBy(desc(youtubeAnalysesTable.createdAt))
    .limit(1);

  const archetypeScores = latestAnalysis[0]
    ? await db
        .select()
        .from(youtubeArchetypeScoresTable)
        .where(eq(youtubeArchetypeScoresTable.analysisId, latestAnalysis[0].id))
        .orderBy(desc(youtubeArchetypeScoresTable.score))
    : [];

  const recentComments = await db
    .select({
      id: youtubeCommentsTable.id,
      body: youtubeCommentsTable.body,
      likes: youtubeCommentsTable.likes,
      createdAt: youtubeCommentsTable.createdAt,
      commentUrl: youtubeCommentsTable.commentUrl,
    })
    .from(youtubeCommentsTable)
    .where(eq(youtubeCommentsTable.authorUsername, user.username))
    .orderBy(desc(youtubeCommentsTable.createdAt));

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

router.get("/youtube/archetypes", async (_req, res): Promise<void> => {
  const statsRaw = await db
    .select({
      archetypeKey: youtubeArchetypeScoresTable.archetypeKey,
      archetypeName: youtubeArchetypeScoresTable.archetypeName,
      userCount: sql<number>`COUNT(DISTINCT ${youtubeArchetypeScoresTable.userId})`,
      averageScore: sql<number>`AVG(${youtubeArchetypeScoresTable.score})`,
    })
    .from(youtubeArchetypeScoresTable)
    .where(and(gt(youtubeArchetypeScoresTable.score, 30), eq(youtubeArchetypeScoresTable.isLatest, true)))
    .groupBy(youtubeArchetypeScoresTable.archetypeKey, youtubeArchetypeScoresTable.archetypeName);

  const statsMap = Object.fromEntries(statsRaw.map((s) => [s.archetypeKey, s]));

  const topThemesRaw = await db.execute<{ archetype_key: string; theme: string; cnt: number }>(
    sql`
      SELECT aks.archetype_key, unnest(a.recurring_themes) AS theme, COUNT(*) AS cnt
      FROM youtube_archetype_scores aks
      JOIN youtube_analyses a ON a.id = aks.analysis_id
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

router.get("/youtube/archetypes/:key/users", async (req, res): Promise<void> => {
  const pathParams = GetYoutubeArchetypeUsersParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }

  const queryParams = GetYoutubeArchetypeUsersQueryParams.safeParse(req.query);
  const minScore = queryParams.success && queryParams.data.minScore != null ? queryParams.data.minScore : 1;
  const limit = queryParams.success && queryParams.data.limit != null ? queryParams.data.limit : 100;

  // Dedupe per user: take each user's highest score for this archetype rather
  // than one row per analysis.
  const usersRaw = await db
    .select({
      id: youtubeUsersTable.id,
      username: youtubeUsersTable.username,
      displayName: youtubeUsersTable.displayName,
      profileUrl: youtubeUsersTable.profileUrl,
      firstSeen: youtubeUsersTable.firstSeen,
      lastSeen: youtubeUsersTable.lastSeen,
      totalComments: youtubeUsersTable.totalComments,
      totalPosts: youtubeUsersTable.totalPosts,
      score: sql<number>`MAX(${youtubeArchetypeScoresTable.score})`,
    })
    .from(youtubeArchetypeScoresTable)
    .innerJoin(youtubeUsersTable, eq(youtubeUsersTable.id, youtubeArchetypeScoresTable.userId))
    .where(
      and(
        sql`${youtubeArchetypeScoresTable.archetypeKey} = ${pathParams.data.key}`,
        eq(youtubeArchetypeScoresTable.isLatest, true),
      ),
    )
    .groupBy(youtubeUsersTable.id)
    .having(sql`MAX(${youtubeArchetypeScoresTable.score}) >= ${minScore}`)
    .orderBy(desc(sql`MAX(${youtubeArchetypeScoresTable.score})`))
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

router.get("/youtube/search", async (req, res): Promise<void> => {
  const params = SearchYoutubeUsersQueryParams.safeParse(req.query);
  const q = params.success ? params.data.q : undefined;
  const archetype = params.success ? params.data.archetype : undefined;
  const minScore = params.success && params.data.minScore != null ? params.data.minScore : 0;
  const limit = params.success && params.data.limit != null ? params.data.limit : 50;

  if (archetype) {
    const results = await db
      .select({
        id: youtubeUsersTable.id,
        username: youtubeUsersTable.username,
        displayName: youtubeUsersTable.displayName,
        profileUrl: youtubeUsersTable.profileUrl,
        firstSeen: youtubeUsersTable.firstSeen,
        lastSeen: youtubeUsersTable.lastSeen,
        totalComments: youtubeUsersTable.totalComments,
        totalPosts: youtubeUsersTable.totalPosts,
        topScore: youtubeArchetypeScoresTable.score,
        dominantArchetype: youtubeArchetypeScoresTable.archetypeName,
      })
      .from(youtubeArchetypeScoresTable)
      .innerJoin(youtubeUsersTable, eq(youtubeUsersTable.id, youtubeArchetypeScoresTable.userId))
      .where(
        and(
          sql`${youtubeArchetypeScoresTable.archetypeKey} = ${archetype}`,
          eq(youtubeArchetypeScoresTable.isLatest, true),
          sql`${youtubeArchetypeScoresTable.score} >= ${minScore}`,
          q ? ilike(youtubeUsersTable.displayName, `%${q}%`) : undefined,
        ),
      )
      .orderBy(desc(youtubeArchetypeScoresTable.score))
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
      id: youtubeUsersTable.id,
      username: youtubeUsersTable.username,
      displayName: youtubeUsersTable.displayName,
      profileUrl: youtubeUsersTable.profileUrl,
      firstSeen: youtubeUsersTable.firstSeen,
      lastSeen: youtubeUsersTable.lastSeen,
      totalComments: youtubeUsersTable.totalComments,
      totalPosts: youtubeUsersTable.totalPosts,
      topScore: sql<number>`MAX(${youtubeArchetypeScoresTable.score})`,
      dominantArchetype: sql<string>`(array_agg(${youtubeArchetypeScoresTable.archetypeName} ORDER BY ${youtubeArchetypeScoresTable.score} DESC))[1]`,
    })
    .from(youtubeUsersTable)
    .leftJoin(
      youtubeArchetypeScoresTable,
      and(eq(youtubeArchetypeScoresTable.userId, youtubeUsersTable.id), eq(youtubeArchetypeScoresTable.isLatest, true)),
    )
    .where(q ? ilike(youtubeUsersTable.displayName, `%${q}%`) : undefined)
    .groupBy(youtubeUsersTable.id)
    .orderBy(desc(youtubeUsersTable.lastSeen))
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

router.post("/youtube/classify", async (req, res): Promise<void> => {
  if (await isYoutubeClassificationRunning()) {
    res.status(200).json({ status: "already_running", pending: 0 });
    return;
  }

  const pending = await countUnanalyzedYoutubeUsers();
  if (pending === 0) {
    res.status(200).json({ status: "nothing_to_do", pending: 0 });
    return;
  }

  classifyAllUnanalyzedYoutubeUsers(req.session.user ?? null).catch((err) => {
    logger.error({ err }, "Youtube classification backfill failed");
  });

  res.status(202).json({ status: "started", pending });
});

interface YoutubeUserRow {
  id: number;
  username: string;
  displayName: string;
  profileUrl: string | null;
  firstSeen: Date | null;
  lastSeen: Date | null;
  totalComments: number;
  totalPosts: number;
}

function serializeUser(u: YoutubeUserRow) {
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
