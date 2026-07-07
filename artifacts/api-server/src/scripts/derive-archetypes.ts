/**
 * One-time setup: derive a FIXED archetype taxonomy fitted to your community.
 *
 * Point the app at the kind of community you will analyse (e.g. a subreddit),
 * and this generates a set of archetypes tailored to it. The result is stored in
 * the database and becomes the single fixed taxonomy used for ALL subsequent
 * crawls and classification — it does not change per post or per run.
 *
 * The same thing can be done from the Admin page ("Archetype Taxonomy" card)
 * without the command line.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run derive-archetypes "<source>" "[description]"
 *
 * Examples:
 *   pnpm --filter @workspace/api-server run derive-archetypes "r/politics" "US national politics"
 *   pnpm --filter @workspace/api-server run derive-archetypes "r/gaming" "Video game enthusiast community"
 *
 * Re-run it any time to regenerate for a different community (it overwrites the
 * stored taxonomy). Restart the API server afterwards to apply. A generic
 * default ships in the repo and is used if you never run this.
 */
import { deriveArchetypes } from "../lib/derive-archetypes";
import { setSetting, SETTING_ARCHETYPES } from "../lib/settings";

async function main(): Promise<void> {
  const source = process.argv[2];
  const description = process.argv[3] ?? "";
  if (!source) {
    console.error(
      'Usage: pnpm --filter @workspace/api-server run derive-archetypes "<source>" "[description]"',
    );
    process.exit(1);
  }

  console.log(`Deriving archetypes for "${source}"${description ? ` (${description})` : ""}...`);

  const archetypes = await deriveArchetypes(source, description);
  await setSetting(SETTING_ARCHETYPES, JSON.stringify(archetypes));

  console.log(`Stored ${archetypes.length} archetypes:`);
  for (const a of archetypes) console.log(`  - ${a.key}: ${a.name}`);
  console.log("\nDone. Restart the API server to apply this taxonomy to all future crawls.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
