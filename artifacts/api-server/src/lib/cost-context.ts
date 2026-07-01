import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request/job-scoped attribution context for cost tracking. Set once at an entry
 * point (e.g. a topic-analysis run or a user investigation), it lets the deep
 * cost-capture hooks in `runApifyActor` and `extractCompletionText` know WHICH app
 * account to bill — without threading an `appUser` argument through every analysis
 * function.
 *
 * `appUser` is null for platform/shared work (subreddit crawls, batch
 * classification) that isn't attributable to a single initiating account.
 */
export interface CostContext {
  appUser: string | null;
  category: "topic_analysis" | "investigate" | "subreddit" | "batch_classify" | "other";
}

const storage = new AsyncLocalStorage<CostContext>();

export function withCostContext<T>(ctx: CostContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function getCostContext(): CostContext | undefined {
  return storage.getStore();
}
