import { openai } from "@workspace/integrations-openai-ai-server";
import { jsonrepair } from "jsonrepair";
import type { Archetype } from "./archetypes";

const MODEL = "gpt-5.2";

function parseJsonObject<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(slice) as T;
  } catch {
    return JSON.parse(jsonrepair(slice)) as T;
  }
}

function toKey(raw: string): string {
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

/**
 * Derive a FIXED archetype taxonomy fitted to a single community via the LLM.
 * Always appends a `mixed_unclassified` catch-all. This function is pure — it
 * does not persist anything; the caller decides where to store the result.
 */
export async function deriveArchetypes(source: string, description = ""): Promise<Archetype[]> {
  const prompt = `You are a political-sociology analyst designing a FIXED archetype taxonomy for classifying the members of one specific online community.

Community: ${source}
${description ? `Context: ${description}` : ""}

Produce a set of 10 to 14 DISTINCT archetypes that capture the major recurring ideological stances, factions, and participant personas actually found in THIS community. Tailor them to this community specifically — for a US national-politics forum they might be e.g. progressive_democrat, establishment_democrat, maga_populist, traditional_conservative, libertarian; for a gaming community they would be entirely different. Do not output a generic one-size-fits-all list.

Return STRICT JSON only (no markdown), of the exact shape:
{"archetypes":[{"key":"snake_case_id","name":"Human Readable Name","description":"one concise sentence","indicators":["2 to 4 short observable signals in a member's posts"],"relatedArchetypes":["1 to 3 keys of OTHER archetypes in this same list"]}]}

Rules:
- keys are unique, lowercase snake_case, and stable/reusable.
- Do NOT include a generic "other", "unclassified", "mixed", or "neutral" catch-all — one is appended automatically.
- relatedArchetypes must only reference keys that appear elsewhere in your list.
- Output JSON only.`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("Model returned no content.");

  const parsed = parseJsonObject<{ archetypes?: unknown }>(raw);
  const rawList = Array.isArray(parsed.archetypes) ? parsed.archetypes : [];
  if (rawList.length === 0) throw new Error("Model did not return any archetypes.");

  const seen = new Set<string>();
  const archetypes: Archetype[] = [];
  for (const item of rawList) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const key = toKey(String(rec.key ?? rec.name ?? ""));
    if (!key || seen.has(key) || key === "mixed_unclassified") continue;
    seen.add(key);
    archetypes.push({
      key,
      name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : key,
      description: typeof rec.description === "string" ? rec.description.trim() : "",
      indicators: Array.isArray(rec.indicators)
        ? rec.indicators.filter((x): x is string => typeof x === "string").slice(0, 4)
        : [],
      relatedArchetypes: Array.isArray(rec.relatedArchetypes)
        ? rec.relatedArchetypes.filter((x): x is string => typeof x === "string").map(toKey)
        : [],
    });
  }

  if (archetypes.length === 0) throw new Error("No valid archetypes after parsing the model response.");

  const validKeys = new Set(archetypes.map((a) => a.key));
  for (const a of archetypes) {
    a.relatedArchetypes = [...new Set(a.relatedArchetypes)]
      .filter((k) => k !== a.key && validKeys.has(k))
      .slice(0, 3);
  }

  archetypes.push({
    key: "mixed_unclassified",
    name: "Mixed / Unclassified",
    description: "No single dominant stance; mixed, ambiguous, or insufficient signals.",
    indicators: ["no consistent stance", "mixed or ambiguous signals"],
    relatedArchetypes: [],
  });

  return archetypes;
}
