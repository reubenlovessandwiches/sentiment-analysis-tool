import { Router, type IRouter } from "express";
import { db, archetypeScoresTable, redditUsersTable, analysesTable } from "@workspace/db";
import { eq, desc, gt, sql, count, and } from "drizzle-orm";
import { GetArchetypeUsersParams, GetArchetypeUsersQueryParams } from "@workspace/api-zod";
import { ARCHETYPES } from "../lib/archetypes";

const router: IRouter = Router();

router.get("/archetypes", async (_req, res): Promise<void> => {
  const statsRaw = await db
    .select({
      archetypeKey: archetypeScoresTable.archetypeKey,
      archetypeName: archetypeScoresTable.archetypeName,
      userCount: sql<number>`COUNT(DISTINCT ${archetypeScoresTable.userId})`,
      averageScore: sql<number>`AVG(${archetypeScoresTable.score})`,
    })
    .from(archetypeScoresTable)
    .where(and(gt(archetypeScoresTable.score, 30), eq(archetypeScoresTable.isLatest, true)))
    .groupBy(archetypeScoresTable.archetypeKey, archetypeScoresTable.archetypeName);

  const statsMap = Object.fromEntries(statsRaw.map((s) => [s.archetypeKey, s]));

  const topThemesRaw = await db.execute<{ archetype_key: string; theme: string; cnt: number }>(
    sql`
      SELECT aks.archetype_key, unnest(a.recurring_themes) AS theme, COUNT(*) AS cnt
      FROM archetype_scores aks
      JOIN analyses a ON a.id = aks.analysis_id
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

router.get("/archetypes/:key/users", async (req, res): Promise<void> => {
  const pathParams = GetArchetypeUsersParams.safeParse(req.params);
  if (!pathParams.success) {
    res.status(400).json({ error: pathParams.error.message });
    return;
  }

  const queryParams = GetArchetypeUsersQueryParams.safeParse(req.query);
  const minScore = queryParams.success && queryParams.data.minScore != null ? queryParams.data.minScore : 40;
  const limit = queryParams.success && queryParams.data.limit != null ? queryParams.data.limit : 50;

  // Dedupe per user: a user may have multiple analyses over time, so take their
  // highest score for this archetype rather than emitting one row per analysis.
  const usersRaw = await db
    .select({
      id: redditUsersTable.id,
      username: redditUsersTable.username,
      firstSeen: redditUsersTable.firstSeen,
      lastSeen: redditUsersTable.lastSeen,
      totalComments: redditUsersTable.totalComments,
      totalPosts: redditUsersTable.totalPosts,
      score: sql<number>`MAX(${archetypeScoresTable.score})`,
    })
    .from(archetypeScoresTable)
    .innerJoin(redditUsersTable, eq(redditUsersTable.id, archetypeScoresTable.userId))
    .where(and(sql`${archetypeScoresTable.archetypeKey} = ${pathParams.data.key}`, eq(archetypeScoresTable.isLatest, true)))
    .groupBy(redditUsersTable.id)
    .having(sql`MAX(${archetypeScoresTable.score}) >= ${minScore}`)
    .orderBy(desc(sql`MAX(${archetypeScoresTable.score})`))
    .limit(limit);

  res.json(
    usersRaw.map((u) => ({
      user: {
        id: u.id,
        username: u.username,
        firstSeen: u.firstSeen?.toISOString() ?? null,
        lastSeen: u.lastSeen?.toISOString() ?? null,
        totalComments: u.totalComments,
        totalPosts: u.totalPosts,
      },
      dominantArchetype: pathParams.data.key,
      topScore: u.score,
      analysisCount: 1,
    })),
  );
});

export default router;
