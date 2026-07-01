import { Router, type IRouter } from "express";
import { db, subredditsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateSubredditBody, UpdateSubredditBody, UpdateSubredditParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/subreddits", async (_req, res): Promise<void> => {
  const subreddits = await db.select().from(subredditsTable).orderBy(subredditsTable.createdAt);
  res.json(
    subreddits.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
    })),
  );
});

router.post("/subreddits", async (req, res): Promise<void> => {
  const parsed = CreateSubredditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [subreddit] = await db
    .insert(subredditsTable)
    .values(parsed.data)
    .returning();

  res.status(201).json({ ...subreddit, createdAt: subreddit.createdAt.toISOString() });
});

router.patch("/subreddits/:id", async (req, res): Promise<void> => {
  const params = UpdateSubredditParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateSubredditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [subreddit] = await db
    .update(subredditsTable)
    .set(parsed.data)
    .where(eq(subredditsTable.id, params.data.id))
    .returning();

  if (!subreddit) {
    res.status(404).json({ error: "Subreddit not found" });
    return;
  }

  res.json({ ...subreddit, createdAt: subreddit.createdAt.toISOString() });
});

export default router;
