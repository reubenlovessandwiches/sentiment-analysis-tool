import { Router, type IRouter } from "express";
import { db, redditUsersTable, archetypeScoresTable } from "@workspace/db";
import { eq, ilike, desc, and, sql, gte } from "drizzle-orm";
import { SearchUsersQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/search", async (req, res): Promise<void> => {
  const params = SearchUsersQueryParams.safeParse(req.query);
  const q = params.success ? params.data.q : undefined;
  const archetype = params.success ? params.data.archetype : undefined;
  const minScore = params.success && params.data.minScore != null ? params.data.minScore : 0;
  const minConfidence = params.success && params.data.minConfidence != null ? params.data.minConfidence : 0;
  const limit = params.success && params.data.limit != null ? params.data.limit : 50;

  if (archetype) {
    const results = await db
      .select({
        id: redditUsersTable.id,
        username: redditUsersTable.username,
        firstSeen: redditUsersTable.firstSeen,
        lastSeen: redditUsersTable.lastSeen,
        totalComments: redditUsersTable.totalComments,
        totalPosts: redditUsersTable.totalPosts,
        topScore: archetypeScoresTable.score,
        dominantArchetype: archetypeScoresTable.archetypeName,
      })
      .from(archetypeScoresTable)
      .innerJoin(redditUsersTable, eq(redditUsersTable.id, archetypeScoresTable.userId))
      .where(
        and(
          sql`${archetypeScoresTable.archetypeKey} = ${archetype}`,
          eq(archetypeScoresTable.isLatest, true),
          gte(archetypeScoresTable.score, minScore),
          gte(archetypeScoresTable.confidence, minConfidence),
          q ? ilike(redditUsersTable.username, `%${q}%`) : undefined,
        ),
      )
      .orderBy(desc(archetypeScoresTable.score))
      .limit(limit);

    res.json(
      results.map((r) => ({
        user: {
          id: r.id,
          username: r.username,
          firstSeen: r.firstSeen?.toISOString() ?? null,
          lastSeen: r.lastSeen?.toISOString() ?? null,
          totalComments: r.totalComments,
          totalPosts: r.totalPosts,
        },
        dominantArchetype: r.dominantArchetype ?? null,
        topScore: r.topScore ? Number(r.topScore) : null,
        analysisCount: 1,
      })),
    );
    return;
  }

  const results = await db
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
    .where(q ? ilike(redditUsersTable.username, `%${q}%`) : undefined)
    .groupBy(redditUsersTable.id)
    .orderBy(desc(redditUsersTable.lastSeen))
    .limit(limit);

  res.json(
    results.map((r) => ({
      user: {
        id: r.id,
        username: r.username,
        firstSeen: r.firstSeen?.toISOString() ?? null,
        lastSeen: r.lastSeen?.toISOString() ?? null,
        totalComments: r.totalComments,
        totalPosts: r.totalPosts,
      },
      dominantArchetype: r.dominantArchetype ?? null,
      topScore: r.topScore ? Number(r.topScore) : null,
      analysisCount: 0,
    })),
  );
});

export default router;
