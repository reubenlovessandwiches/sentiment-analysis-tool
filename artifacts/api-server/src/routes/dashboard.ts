import { Router, type IRouter } from "express";
import { db, redditUsersTable, postsTable, commentsTable, analysesTable, archetypeScoresTable, jobsTable } from "@workspace/db";
import { sql, count, avg, eq, desc, gt, and } from "drizzle-orm";
import { GetDashboardQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard", async (req, res): Promise<void> => {
  const params = GetDashboardQueryParams.safeParse(req.query);
  const subredditId = params.success ? params.data.subredditId : undefined;

  const [
    [userCount],
    [postCount],
    [commentCount],
    [analysisCount],
    [analyzedUserCount],
    [activeJobCount],
  ] = await Promise.all([
    db.select({ count: count() }).from(redditUsersTable),
    db.select({ count: count() }).from(postsTable),
    db.select({ count: count() }).from(commentsTable),
    db.select({ count: count() }).from(analysesTable),
    db.select({ count: sql<number>`COUNT(DISTINCT ${analysesTable.userId})` }).from(analysesTable),
    db.select({ count: count() }).from(jobsTable).where(sql`status IN ('pending', 'running')`),
  ]);

  const totalUsers = Number(userCount?.count ?? 0);
  const analyzedUsers = Number(analyzedUserCount?.count ?? 0);
  const unanalyzedUsers = Math.max(0, totalUsers - analyzedUsers);

  const archetypeDistribution = await db
    .select({
      archetypeKey: archetypeScoresTable.archetypeKey,
      archetypeName: archetypeScoresTable.archetypeName,
      userCount: sql<number>`COUNT(DISTINCT ${archetypeScoresTable.userId})`,
    })
    .from(archetypeScoresTable)
    .where(and(gt(archetypeScoresTable.score, 40), eq(archetypeScoresTable.isLatest, true), sql`${archetypeScoresTable.archetypeKey} != 'mixed_unclassified'`))
    .groupBy(archetypeScoresTable.archetypeKey, archetypeScoresTable.archetypeName)
    .orderBy(desc(sql`COUNT(DISTINCT ${archetypeScoresTable.userId})`))
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
        COUNT(*) FILTER (WHERE TRUE) AS posts,
        0 AS comments
      FROM posts
      WHERE posted_at > NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
      LIMIT 30
    `,
  );

  const topUsersRaw = await db
    .select({
      id: redditUsersTable.id,
      username: redditUsersTable.username,
      firstSeen: redditUsersTable.firstSeen,
      lastSeen: redditUsersTable.lastSeen,
      totalComments: redditUsersTable.totalComments,
      totalPosts: redditUsersTable.totalPosts,
      topScore: sql<number>`MAX(${archetypeScoresTable.score})`,
      dominantArchetype: sql<string>`(array_agg(${archetypeScoresTable.archetypeName} ORDER BY ${archetypeScoresTable.score} DESC))[1]`,
    })
    .from(redditUsersTable)
    .leftJoin(
      archetypeScoresTable,
      and(eq(archetypeScoresTable.userId, redditUsersTable.id), eq(archetypeScoresTable.isLatest, true)),
    )
    .groupBy(redditUsersTable.id)
    .having(sql`(array_agg(${archetypeScoresTable.archetypeKey} ORDER BY ${archetypeScoresTable.score} DESC))[1] != 'mixed_unclassified'`)
    .orderBy(desc(sql`MAX(${archetypeScoresTable.score})`))
    .limit(10);

  const topUsers = topUsersRaw.map((u) => ({
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
    analysisCount: 0,
  }));

  const topThemesRaw = await db.execute<{ theme: string; count: number }>(
    sql`
      SELECT theme, COUNT(*) AS count
      FROM (
        SELECT unnest(theme_labels) AS theme
        FROM analyses
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
    topThemes: (topThemesRaw.rows ?? []).map((r) => ({
      theme: r.theme,
      count: Number(r.count),
    })),
  });
});

router.get("/dashboard/theme-details", async (req, res): Promise<void> => {
  const label = typeof req.query.label === "string" ? req.query.label : null;
  if (!label) {
    res.status(400).json({ error: "label query param required" });
    return;
  }

  const rows = await db.execute<{ username: string; description: string }>(
    sql`
      SELECT ru.username,
             (a.recurring_themes)[array_position(a.theme_labels, ${label})] AS description
      FROM analyses a
      JOIN reddit_users ru ON ru.id = a.user_id
      WHERE ${label} = ANY(a.theme_labels)
        AND a.is_latest
        AND (a.recurring_themes)[array_position(a.theme_labels, ${label})] IS NOT NULL
      ORDER BY ru.username
      LIMIT 50
    `,
  );

  res.json({
    label,
    items: (rows.rows ?? []).map((r) => ({
      username: r.username,
      description: r.description,
    })),
  });
});

export default router;
