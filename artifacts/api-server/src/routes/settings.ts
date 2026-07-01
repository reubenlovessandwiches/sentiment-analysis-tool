import { Router, type IRouter } from "express";
import { UpdateApifySettingsBody } from "@workspace/api-zod";
import {
  getSetting,
  setSetting,
  deleteSetting,
  maskKey,
  SETTING_APIFY_TOKEN,
  SETTING_APIFY_ACTOR_ID,
  SETTING_APIFY_FACEBOOK_ACTOR_ID,
  SETTING_APIFY_INSTAGRAM_ACTOR_ID,
  SETTING_APIFY_TIKTOK_ACTOR_ID,
  SETTING_APIFY_TWITTER_ACTOR_ID,
  SETTING_APIFY_YOUTUBE_ACTOR_ID,
  SETTING_ARCTIC_FALLBACK,
  isArcticFallbackEnabled,
  DEFAULT_APIFY_ACTOR_ID,
  DEFAULT_FACEBOOK_ACTOR_ID,
  DEFAULT_INSTAGRAM_ACTOR_ID,
  DEFAULT_TIKTOK_ACTOR_ID,
  DEFAULT_TWITTER_ACTOR_ID,
  DEFAULT_YOUTUBE_ACTOR_ID,
} from "../lib/settings";

const router: IRouter = Router();

async function buildApifyStatus() {
  const token = await getSetting(SETTING_APIFY_TOKEN);
  const actorId = (await getSetting(SETTING_APIFY_ACTOR_ID)) ?? DEFAULT_APIFY_ACTOR_ID;
  const facebookActorId = (await getSetting(SETTING_APIFY_FACEBOOK_ACTOR_ID)) ?? DEFAULT_FACEBOOK_ACTOR_ID;
  const instagramActorId = (await getSetting(SETTING_APIFY_INSTAGRAM_ACTOR_ID)) ?? DEFAULT_INSTAGRAM_ACTOR_ID;
  const tiktokActorId = (await getSetting(SETTING_APIFY_TIKTOK_ACTOR_ID)) ?? DEFAULT_TIKTOK_ACTOR_ID;
  const twitterActorId = (await getSetting(SETTING_APIFY_TWITTER_ACTOR_ID)) ?? DEFAULT_TWITTER_ACTOR_ID;
  const youtubeActorId = (await getSetting(SETTING_APIFY_YOUTUBE_ACTOR_ID)) ?? DEFAULT_YOUTUBE_ACTOR_ID;
  return {
    configured: !!token,
    maskedKey: maskKey(token),
    actorId,
    facebookActorId,
    instagramActorId,
    tiktokActorId,
    twitterActorId,
    youtubeActorId,
    arcticFallbackEnabled: await isArcticFallbackEnabled(),
  };
}

router.get("/settings/apify", async (_req, res): Promise<void> => {
  res.json(await buildApifyStatus());
});

router.put("/settings/apify", async (req, res): Promise<void> => {
  const parsed = UpdateApifySettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { apiKey, actorId, facebookActorId, instagramActorId, tiktokActorId, twitterActorId, youtubeActorId, arcticFallbackEnabled } = parsed.data;

  // Only the main admin may change the shared Apify API token. Actor IDs remain
  // editable by any authenticated operator. Members never send a non-empty
  // apiKey from the UI, but guard the API directly too.
  if (apiKey !== undefined && req.session.role !== "admin") {
    res.status(403).json({ error: "Only an admin can change the Apify API token." });
    return;
  }

  if (apiKey !== undefined && apiKey !== null) {
    const trimmed = apiKey.trim();
    if (trimmed === "") {
      await deleteSetting(SETTING_APIFY_TOKEN);
    } else {
      await setSetting(SETTING_APIFY_TOKEN, trimmed);
    }
  }

  if (actorId !== undefined && actorId !== null) {
    const trimmed = actorId.trim();
    if (trimmed === "") {
      await deleteSetting(SETTING_APIFY_ACTOR_ID);
    } else {
      await setSetting(SETTING_APIFY_ACTOR_ID, trimmed);
    }
  }

  if (facebookActorId !== undefined && facebookActorId !== null) {
    const trimmed = facebookActorId.trim();
    if (trimmed === "") {
      await deleteSetting(SETTING_APIFY_FACEBOOK_ACTOR_ID);
    } else {
      await setSetting(SETTING_APIFY_FACEBOOK_ACTOR_ID, trimmed);
    }
  }

  if (instagramActorId !== undefined && instagramActorId !== null) {
    const trimmed = instagramActorId.trim();
    if (trimmed === "") {
      await deleteSetting(SETTING_APIFY_INSTAGRAM_ACTOR_ID);
    } else {
      await setSetting(SETTING_APIFY_INSTAGRAM_ACTOR_ID, trimmed);
    }
  }

  if (tiktokActorId !== undefined && tiktokActorId !== null) {
    const trimmed = tiktokActorId.trim();
    if (trimmed === "") {
      await deleteSetting(SETTING_APIFY_TIKTOK_ACTOR_ID);
    } else {
      await setSetting(SETTING_APIFY_TIKTOK_ACTOR_ID, trimmed);
    }
  }

  if (twitterActorId !== undefined && twitterActorId !== null) {
    const trimmed = twitterActorId.trim();
    if (trimmed === "") {
      await deleteSetting(SETTING_APIFY_TWITTER_ACTOR_ID);
    } else {
      await setSetting(SETTING_APIFY_TWITTER_ACTOR_ID, trimmed);
    }
  }

  if (youtubeActorId !== undefined && youtubeActorId !== null) {
    const trimmed = youtubeActorId.trim();
    if (trimmed === "") {
      await deleteSetting(SETTING_APIFY_YOUTUBE_ACTOR_ID);
    } else {
      await setSetting(SETTING_APIFY_YOUTUBE_ACTOR_ID, trimmed);
    }
  }

  // Default ON: store the explicit "false" only when disabled, otherwise clear
  // the row so the feature stays on by default.
  if (arcticFallbackEnabled !== undefined && arcticFallbackEnabled !== null) {
    if (arcticFallbackEnabled) {
      await deleteSetting(SETTING_ARCTIC_FALLBACK);
    } else {
      await setSetting(SETTING_ARCTIC_FALLBACK, "false");
    }
  }

  res.json(await buildApifyStatus());
});

router.post("/settings/apify/test", async (_req, res): Promise<void> => {
  const token = await getSetting(SETTING_APIFY_TOKEN);
  if (!token) {
    res.json({ ok: false, error: "No API token configured", username: null });
    return;
  }
  try {
    const resp = await fetch("https://api.apify.com/v2/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      res.json({ ok: false, error: `Apify returned HTTP ${resp.status}`, username: null });
      return;
    }
    const body = (await resp.json()) as { data?: { username?: string } };
    res.json({ ok: true, username: body?.data?.username ?? null, error: null });
  } catch {
    res.json({ ok: false, error: "Network error reaching Apify API", username: null });
  }
});

export default router;
