/**
 * Arctic Shift API client — a free public archive of Reddit data
 * (https://arctic-shift.photon-reddit.com, source: github.com/ArthurHeitmann/arctic_shift).
 *
 * Unlike the subreddit/thread crawls that go through Apify (Reddit blocks this
 * app's datacenter IP), Arctic Shift is a third-party archive we can call
 * directly — for free — and it returns a user's full post/comment history,
 * including content that has since been deleted/removed on live Reddit (because
 * the archive captured it at ingest time). It is the only source wired up for
 * per-user investigation. It is best-effort with no uptime guarantee, so callers
 * surface a clear error when it's unavailable rather than falling back anywhere.
 */

import { logger } from "./logger";

const ARCTIC_BASE = "https://arctic-shift.photon-reddit.com";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ArcticKind = "posts" | "comments";

/**
 * Fetch one page of an author's posts or comments, sorted oldest-first, starting
 * at the `after` cursor (a unix-seconds `created_utc`). Retries transient
 * rate-limit/server errors; a 404 is treated as "no data" (unknown user).
 */
async function fetchArcticPage(
  kind: ArcticKind,
  username: string,
  cursor: number | undefined,
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({ author: username, sort: "asc", limit: "100" });
  if (cursor != null) params.set("after", String(cursor));
  const url = `${ARCTIC_BASE}/api/${kind}/search?${params.toString()}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": "AstroOrbiter/1.0 (community-intelligence)" } });
    } catch {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status === 404) return [];
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      // Capture the response body so a validation rejection (e.g. 422) names the
      // exact parameter Arctic Shift refused, instead of just "Unprocessable
      // Entity". Best-effort + truncated (the body may be HTML or large).
      let body = "";
      try {
        body = (await res.text()).slice(0, 500);
      } catch {
        /* body unavailable — keep the status line only */
      }
      logger.warn({ kind, username, cursor, url, status: res.status, statusText: res.statusText, body }, "Arctic Shift search rejected request");
      throw new Error(
        `Arctic Shift ${kind} search failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
      );
    }
    const json = (await res.json()) as unknown;
    const data = Array.isArray(json)
      ? json
      : ((json as { data?: unknown })?.data ?? []);
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  }
  throw new Error(
    `Arctic Shift ${kind} search is unavailable (rate-limited or down after retries). It's a best-effort service — try again later.`,
  );
}

/**
 * Page through an author's entire post or comment history (oldest-first) until
 * exhausted or `maxItems` is reached. Dedupes by Reddit id within the run and
 * advances the cursor by each page's newest `created_utc`. Termination is by
 * "no new items this page" (covers the case where an inclusive `after` keeps
 * returning the boundary item) and a stall guard (cursor failed to advance).
 *
 * @param after  Optional unix-seconds floor — only fetch content newer than this
 *               (used for incremental refresh so we don't re-walk old history).
 */
export async function fetchUserContent(
  kind: ArcticKind,
  username: string,
  maxItems: number,
  after: number | undefined,
  onProgress?: (count: number) => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let cursor = after;

  while (out.length < maxItems) {
    const page = await fetchArcticPage(kind, username, cursor);
    if (page.length === 0) break;

    let maxCu = cursor ?? 0;
    let newInPage = 0;
    for (const item of page) {
      const cu = Number(item.created_utc);
      if (Number.isFinite(cu) && cu > maxCu) maxCu = cu;
      const id = typeof item.id === "string" ? item.id : null;
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(item);
        newInPage++;
        if (out.length >= maxItems) break;
      }
    }

    if (onProgress) await onProgress(out.length);

    // Nothing new on this page → we've caught up to the end of the history.
    if (newInPage === 0) break;
    // Cursor didn't advance → avoid an infinite loop on a same-second cluster.
    if (cursor != null && maxCu <= cursor) break;
    cursor = maxCu;
    // Be polite to a free, best-effort service.
    await sleep(350);
  }

  return out.slice(0, maxItems);
}

/**
 * Look up specific posts/comments by their Reddit fullname-less ids (e.g. a
 * post `abc123` or comment `def456`) directly from the archive, returning a
 * Map keyed by id. Used to recover the real body of an item that live Reddit
 * has since tombstoned ("[ Removed by Reddit ]" etc.) — the archive captured
 * it before removal. Batches into chunks (the by-ids endpoint accepts a
 * comma-separated `ids` list), dedupes, and is resilient to transient errors
 * (a failed batch is skipped, never throws for a single bad batch).
 */
export async function fetchByIds(
  kind: ArcticKind,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  const BATCH = 100;

  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const url = `${ARCTIC_BASE}/api/${kind}/ids?ids=${batch.join(",")}`;

    let page: Array<Record<string, unknown>> | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { "User-Agent": "AstroOrbiter/1.0 (community-intelligence)" } });
      } catch {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (res.status === 404) {
        page = [];
        break;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        // Skip this batch rather than failing the whole recovery pass.
        page = [];
        break;
      }
      const json = (await res.json()) as unknown;
      const data = Array.isArray(json) ? json : ((json as { data?: unknown })?.data ?? []);
      page = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      break;
    }

    if (page) {
      for (const item of page) {
        const id = typeof item.id === "string" ? item.id : null;
        if (id) out.set(id, item);
      }
    }

    if (i + BATCH < unique.length) await sleep(350);
  }

  return out;
}

/** Absolute reddit.com URL for an Arctic item's (relative) permalink, or "". */
export function arcticPermalink(item: Record<string, unknown>): string {
  const p = typeof item.permalink === "string" ? item.permalink : "";
  if (!p) return "";
  return p.startsWith("http") ? p : `https://www.reddit.com${p}`;
}

/** Convert an Arctic item's unix-seconds `created_utc` to a Date, or null. */
export function arcticDate(item: Record<string, unknown>): Date | null {
  const cu = Number(item.created_utc);
  if (!Number.isFinite(cu)) return null;
  const d = new Date(cu * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}
