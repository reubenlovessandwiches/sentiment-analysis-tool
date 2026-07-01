import { Router, type IRouter } from "express";
import {
  db,
  facebookUsersTable,
  facebookPostsTable,
  facebookCommentsTable,
  facebookAnalysesTable,
  facebookArchetypeScoresTable,
  jobsTable,
} from "@workspace/db";
import { sql, count, eq, desc, gt, and, ilike } from "drizzle-orm";
import {
  ListFacebookUsersQueryParams,
  SearchFacebookUsersQueryParams,
  GetFacebookArchetypeUsersParams,
  GetFacebookArchetypeUsersQueryParams,
} from "@workspace/api-zod";
import { ARCHETYPES } from "../lib/archetypes";
import { classifyUnanalyzedFacebookUsers } from "../lib/facebook-classify";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** True if a Facebook classification batch is currently running. */
async function isFacebookClassificationRunning(): Promise<boolean> {
  const [running] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(eq(jobsTable.jobType, "analyze_facebook_batch"), eq(jobsTable.status, "running")))
    .limit(1);
  return Boolean(running);
}

/**
 * Count Facebook users that have ingested content but no current analysis (or
 * new content since their latest one). Mirrors the targeting in
 * classifyUnanalyzedFacebookUsers so the /facebook/classify gate stays accurate.
 */
async function countUnanalyzedFacebookUsers(): Promise<number> {
  const rows = await db.execute<{ count: number }>(
    sql`
      SELECT COUNT(*)::int AS count
      FROM facebook_users u
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_at FROM facebook_analyses WHERE user_id = u.id
      ) la ON TRUE
      WHERE la.last_at IS NULL
         OR EXISTS (
           SELECT 1 FROM facebook_comments c
           WHERE c.author_profile_id = u.profile_id AND c.created_at > la.last_at
         )
    `,
  );
  return Number(rows.rows?.[0]?.count ?? 0);
}

/**
 * Classify every unanalyzed Facebook user. classifyUnanalyzedFacebookUsers caps
 * each pass at 500 users, so loop until none remain (bounded) — this lets a
 * single trigger fully backfill a large ingest.
 */
async function classifyAllUnanalyzedFacebookUsers(launchedBy: string | null = null): Promise<void> {
  for (let pass = 0; pass < 20; pass++) {
    await classifyUnanalyzedFacebookUsers(launchedBy);
    if ((await countUnanalyzedFacebookUsers()) === 0) break;
  }
}

router.get("/facebook/dashboard", async (_req, res): Promise<void> => {
  const [[userCount], [postCount], [commentCount], [analysisCount], [analyzedUserCount], [activeJobCount]] =
    await Promise.all([
      db.select({ count: count() }).from(facebookUsersTable),
      db.select({ count: count() }).from(facebookPostsTable),
      db.select({ count: count() }).from(facebookCommentsTable),
      db.select({ count: count() }).from(facebookAnalysesTable),
      db.select({ count: sql<number>`COUNT(DISTINCT ${facebookAnalysesTable.userId})` }).from(facebookAnalysesTable),
      db.select({ count: count() }).from(jobsTable).where(sql`status IN ('pending', 'running')`),
    ]);

  const totalUsers = Number(userCount?.count ?? 0);
  const analyzedUsers = Number(analyzedUserCount?.count ?? 0);
  const unanalyzedUsers = Math.max(0, totalUsers - analyzedUsers);

  const archetypeDistribution = await db
    .select({
      archetypeKey: facebookArchetypeScoresTable.archetypeKey,
      archetypeName: facebookArchetypeScoresTable.archetypeName,
      userCount: sql<number>`COUNT(DISTINCT ${facebookArchetypeScoresTable.userId})`,
    })
    .from(facebookArchetypeScoresTable)
    .where(
      and(
        gt(facebookArchetypeScoresTable.score, 40),
        eq(facebookArchetypeScoresTable.isLatest, true),
        sql`${facebookArchetypeScoresTable.archetypeKey} != 'mixed_unclassified'`,
      ),
    )
    .groupBy(facebookArchetypeScoresTable.archetypeKey, facebookArchetypeScoresTable.archetypeName)
    .orderBy(desc(sql`COUNT(DISTINCT ${facebookArchetypeScoresTable.userId})`))
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
      FROM facebook_comments
      WHERE posted_at > NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
      LIMIT 30
    `,
  );

  const topUsersRaw = await db
    .select({
      id: facebookUsersTable.id,
      profileId: facebookUsersTable.profileId,
      displayName: facebookUsersTable.displayName,
      profileUrl: facebookUsersTable.profileUrl,
      firstSeen: facebookUsersTable.firstSeen,
      lastSeen: facebookUsersTable.lastSeen,
      totalComments: facebookUsersTable.totalComments,
      totalPosts: facebookUsersTable.totalPosts,
      topScore: sql<number>`MAX(${facebookArchetypeScoresTable.score})`,
      dominantArchetype: sql<string>`(array_agg(${facebookArchetypeScoresTable.archetypeName} ORDER BY ${facebookArchetypeScoresTable.score} DESC))[1]`,
    })
    .from(facebookUsersTable)
    .leftJoin(
      facebookArchetypeScoresTable,
      and(eq(facebookArchetypeScoresTable.userId, facebookUsersTable.id), eq(facebookArchetypeScoresTable.isLatest, true)),
    )
    .groupBy(facebookUsersTable.id)
    .having(
      sql`(array_agg(${facebookArchetypeScoresTable.archetypeKey} ORDER BY ${facebookArchetypeScoresTable.score} DESC))[1] != 'mixed_unclassified'`,
    )
    .orderBy(desc(sql`MAX(${facebookArchetypeScoresTable.score})`))
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
        FROM facebook_analyses
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

router.get("/facebook/dashboard/theme-details", async (req, res): Promise<void> => {
  const label = typeof req.query.label === "string" ? req.query.label : null;
  if (!label) {
    res.status(400).json({ error: "label query param required" });
    return;
  }

  const rows = await db.execute<{ profile_id: string; display_name: string; description: string }>(
    sql`
      SELECT fu.profile_id,
             fu.display_name,
             (a.recurring_themes)[array_position(a.theme_labels, ${label})] AS description
      FROM facebook_analyses a
      JOIN facebook_users fu ON fu.id = a.user_id
      WHERE ${label} = ANY(a.theme_labels)
        AND a.is_latest
        AND (a.recurring_themes)[array_position(a.theme_labels, ${label})] IS NOT NULL
      ORDER BY fu.display_name
      LIMIT 50
    `,
  );

  res.json({
    label,
    items: (rows.rows ?? []).map((r) => ({
      profileId: r.profile_id,
      displayName: r.display_name,
      description: r.description,
    })),
  });
});

router.get("/facebook/users", async (req, res): Promise<void> => {
  const params = ListFacebookUsersQueryParams.safeParse(req.query);
  const limit = params.success && params.data.limit ? params.data.limit : 50;
  const offset = params.success && params.data.offset ? params.data.offset : 0;
  const q = params.success && params.data.q ? params.data.q.trim() : undefined;
  const archetypeFilter = params.success ? params.data.archetype : undefined;
  const minScore = params.success && params.data.minScore != null ? params.data.minScore : undefined;
  const sortBy = params.success && params.data.sortBy ? params.data.sortBy : "recent";

  const conditions = [];
  if (q) {
    // Fuzzy, forgiving search: substring match on the display name OR the
    // Facebook profile ID, plus trigram similarity so close misspellings still
    // surface as suggestions rather than requiring an exact match.
    const like = `%${q}%`;
    conditions.push(
      sql`(${facebookUsersTable.displayName} ILIKE ${like} OR ${facebookUsersTable.profileId} ILIKE ${like} OR similarity(${facebookUsersTable.displayName}, ${q}) > 0.15)`,
    );
  }
  if (archetypeFilter) {
    const threshold = minScore ?? 1;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${facebookArchetypeScoresTable} s WHERE s.user_id = ${facebookUsersTable.id} AND s.is_latest AND s.archetype_key = ${archetypeFilter} AND s.score >= ${threshold})`,
    );
  } else if (minScore != null) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${facebookArchetypeScoresTable} s WHERE s.user_id = ${facebookUsersTable.id} AND s.is_latest AND s.score >= ${minScore})`,
    );
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orderByClause = q
    ? // When searching, rank by relevance so the closest matches lead.
      desc(sql`GREATEST(similarity(${facebookUsersTable.displayName}, ${q}), similarity(${facebookUsersTable.profileId}, ${q}))`)
    : sortBy === "name"
      ? facebookUsersTable.displayName
      : sortBy === "score"
        ? desc(sql`MAX(${facebookArchetypeScoresTable.score})`)
        : sortBy === "volume"
          ? desc(sql`(${facebookUsersTable.totalPosts} + ${facebookUsersTable.totalComments})`)
          : desc(facebookUsersTable.lastSeen);

  const usersRaw = await db
    .select({
      id: facebookUsersTable.id,
      profileId: facebookUsersTable.profileId,
      displayName: facebookUsersTable.displayName,
      profileUrl: facebookUsersTable.profileUrl,
      firstSeen: facebookUsersTable.firstSeen,
      lastSeen: facebookUsersTable.lastSeen,
      totalComments: facebookUsersTable.totalComments,
      totalPosts: facebookUsersTable.totalPosts,
      dominantArchetype: sql<string>`(array_agg(${facebookArchetypeScoresTable.archetypeName} ORDER BY ${facebookArchetypeScoresTable.score} DESC))[1]`,
      topScore: sql<number>`MAX(${facebookArchetypeScoresTable.score})`,
      analysisCount: sql<number>`(SELECT COUNT(*) FROM ${facebookAnalysesTable} a WHERE a.user_id = ${facebookUsersTable.id})`,
    })
    .from(facebookUsersTable)
    .leftJoin(
      facebookArchetypeScoresTable,
      and(eq(facebookArchetypeScoresTable.userId, facebookUsersTable.id), eq(facebookArchetypeScoresTable.isLatest, true)),
    )
    .where(whereClause)
    .groupBy(facebookUsersTable.id)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const [totalResult] = await db.select({ count: count() }).from(facebookUsersTable).where(whereClause);

  const users = usersRaw.map((u) => ({
    user: serializeUser(u),
    dominantArchetype: u.dominantArchetype ?? null,
    topScore: u.topScore ? Number(u.topScore) : null,
    analysisCount: Number(u.analysisCount ?? 0),
  }));

  res.json({ users, total: Number(totalResult?.count ?? 0) });
});

router.get("/facebook/users/:profileId", async (req, res): Promise<void> => {
  const profileId = req.params.profileId;

  const [user] = await db
    .select()
    .from(facebookUsersTable)
    .where(eq(facebookUsersTable.profileId, profileId));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const latestAnalysis = await db
    .select()
    .from(facebookAnalysesTable)
    .where(eq(facebookAnalysesTable.userId, user.id))
    .orderBy(desc(facebookAnalysesTable.createdAt))
    .limit(1);

  const archetypeScores = latestAnalysis[0]
    ? await db
        .select()
        .from(facebookArchetypeScoresTable)
        .where(eq(facebookArchetypeScoresTable.analysisId, latestAnalysis[0].id))
        .orderBy(desc(facebookArchetypeScoresTable.score))
    : [];

  const recentComments = await db
    .select({
      id: facebookCommentsTable.id,
      body: facebookCommentsTable.body,
      likes: facebookCommentsTable.likes,
      createdAt: facebookCommentsTable.createdAt,
      commentUrl: facebookCommentsTable.commentUrl,
    })
    .from(facebookCommentsTable)
    .where(eq(facebookCommentsTable.authorProfileId, user.profileId))
    .orderBy(desc(facebookCommentsTable.createdAt));

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
      profileId: user.profileId,
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

router.get("/facebook/archetypes", async (_req, res): Promise<void> => {
  const statsRaw = await db
    .select({
      archetypeKey: facebookArchetypeScoresTable.archetypeKey,
      archetypeName: facebookArchetypeScoresTable.archetypeName,
      userCount: sql<number>`COUNT(DISTINCT ${facebookArchetypeScoresTable.userId})`,
      averageScore: sql<number>`AVG(${facebookArchetypeScoresTable.score})`,
    })
    .from(facebookArchetypeScoresTable)
    .where(and(gt(facebookArchetypeScoresTable.score, 30), eq(facebookArchetypeScoresTable.isLatest, true)))
    .groupBy(facebookArchetypeScoresTable.archetypeKey, facebookArchetypeScoresTable.archetypeName);

  const statsMap = Object.fromEntries(statsRaw.map((s) => [s.archetypeKey, s]));

  const topThemesRaw = await db.execute<{ archetype_key: string; theme: string; cnt: number }>(
    sql`
      SELECT aks.archetype_key, unnest(a.recurring_themes) AS theme, COUNT(*) AS cnt
      FROM facebook_archetype_scores aks
      JOIN facebook_analyses a ON a.id = aks.analysis_id
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

router.get("/facebook/archetypes/:key/users", async (req, res): Promise<void> => {
  const pathParams = GetFacebookArchetypeUsersParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }

  const queryParams = GetFacebookArchetypeUsersQueryParams.safeParse(req.query);
  const minScore = queryParams.success && queryParams.data.minScore != null ? queryParams.data.minScore : 1;
  const limit = queryParams.success && queryParams.data.limit != null ? queryParams.data.limit : 100;

  // Dedupe per user: take each user's highest score for this archetype rather
  // than one row per analysis.
  const usersRaw = await db
    .select({
      id: facebookUsersTable.id,
      profileId: facebookUsersTable.profileId,
      displayName: facebookUsersTable.displayName,
      profileUrl: facebookUsersTable.profileUrl,
      firstSeen: facebookUsersTable.firstSeen,
      lastSeen: facebookUsersTable.lastSeen,
      totalComments: facebookUsersTable.totalComments,
      totalPosts: facebookUsersTable.totalPosts,
      score: sql<number>`MAX(${facebookArchetypeScoresTable.score})`,
    })
    .from(facebookArchetypeScoresTable)
    .innerJoin(facebookUsersTable, eq(facebookUsersTable.id, facebookArchetypeScoresTable.userId))
    .where(
      and(
        sql`${facebookArchetypeScoresTable.archetypeKey} = ${pathParams.data.key}`,
        eq(facebookArchetypeScoresTable.isLatest, true),
      ),
    )
    .groupBy(facebookUsersTable.id)
    .having(sql`MAX(${facebookArchetypeScoresTable.score}) >= ${minScore}`)
    .orderBy(desc(sql`MAX(${facebookArchetypeScoresTable.score})`))
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

router.get("/facebook/search", async (req, res): Promise<void> => {
  const params = SearchFacebookUsersQueryParams.safeParse(req.query);
  const q = params.success ? params.data.q : undefined;
  const archetype = params.success ? params.data.archetype : undefined;
  const minScore = params.success && params.data.minScore != null ? params.data.minScore : 0;
  const limit = params.success && params.data.limit != null ? params.data.limit : 50;

  if (archetype) {
    const results = await db
      .select({
        id: facebookUsersTable.id,
        profileId: facebookUsersTable.profileId,
        displayName: facebookUsersTable.displayName,
        profileUrl: facebookUsersTable.profileUrl,
        firstSeen: facebookUsersTable.firstSeen,
        lastSeen: facebookUsersTable.lastSeen,
        totalComments: facebookUsersTable.totalComments,
        totalPosts: facebookUsersTable.totalPosts,
        topScore: facebookArchetypeScoresTable.score,
        dominantArchetype: facebookArchetypeScoresTable.archetypeName,
      })
      .from(facebookArchetypeScoresTable)
      .innerJoin(facebookUsersTable, eq(facebookUsersTable.id, facebookArchetypeScoresTable.userId))
      .where(
        and(
          sql`${facebookArchetypeScoresTable.archetypeKey} = ${archetype}`,
          eq(facebookArchetypeScoresTable.isLatest, true),
          sql`${facebookArchetypeScoresTable.score} >= ${minScore}`,
          q ? ilike(facebookUsersTable.displayName, `%${q}%`) : undefined,
        ),
      )
      .orderBy(desc(facebookArchetypeScoresTable.score))
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
      id: facebookUsersTable.id,
      profileId: facebookUsersTable.profileId,
      displayName: facebookUsersTable.displayName,
      profileUrl: facebookUsersTable.profileUrl,
      firstSeen: facebookUsersTable.firstSeen,
      lastSeen: facebookUsersTable.lastSeen,
      totalComments: facebookUsersTable.totalComments,
      totalPosts: facebookUsersTable.totalPosts,
      topScore: sql<number>`MAX(${facebookArchetypeScoresTable.score})`,
      dominantArchetype: sql<string>`(array_agg(${facebookArchetypeScoresTable.archetypeName} ORDER BY ${facebookArchetypeScoresTable.score} DESC))[1]`,
    })
    .from(facebookUsersTable)
    .leftJoin(
      facebookArchetypeScoresTable,
      and(eq(facebookArchetypeScoresTable.userId, facebookUsersTable.id), eq(facebookArchetypeScoresTable.isLatest, true)),
    )
    .where(q ? ilike(facebookUsersTable.displayName, `%${q}%`) : undefined)
    .groupBy(facebookUsersTable.id)
    .orderBy(desc(facebookUsersTable.lastSeen))
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

router.post("/facebook/classify", async (req, res): Promise<void> => {
  if (await isFacebookClassificationRunning()) {
    res.status(200).json({ status: "already_running", pending: 0 });
    return;
  }

  const pending = await countUnanalyzedFacebookUsers();
  if (pending === 0) {
    res.status(200).json({ status: "nothing_to_do", pending: 0 });
    return;
  }

  classifyAllUnanalyzedFacebookUsers(req.session.user ?? null).catch((err) => {
    logger.error({ err }, "Facebook classification backfill failed");
  });

  res.status(202).json({ status: "started", pending });
});

interface FacebookUserRow {
  id: number;
  profileId: string;
  displayName: string;
  profileUrl: string | null;
  firstSeen: Date | null;
  lastSeen: Date | null;
  totalComments: number;
  totalPosts: number;
}

function serializeUser(u: FacebookUserRow) {
  return {
    id: u.id,
    profileId: u.profileId,
    displayName: u.displayName,
    profileUrl: u.profileUrl ?? null,
    firstSeen: u.firstSeen?.toISOString() ?? null,
    lastSeen: u.lastSeen?.toISOString() ?? null,
    totalComments: u.totalComments,
    totalPosts: u.totalPosts,
  };
}

export default router;
