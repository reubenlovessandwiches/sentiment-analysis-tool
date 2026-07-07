import { getSetting, SETTING_ARCHETYPES } from "./settings";

export interface Archetype {
  key: string;
  name: string;
  description: string;
  indicators: string[];
  relatedArchetypes: string[];
}

// Default taxonomy shipped with the repo. It is used as-is until a community-
// specific taxonomy is derived (via the Admin page or the derive-archetypes
// script), which is stored in the DB and loaded over this default at startup.
export const ARCHETYPES: Archetype[] = [
  {
    key: "anti_establishment",
    name: "Anti-Establishment",
    description: "Critical of those in power and mainstream institutions",
    indicators: ["criticism of the governing authorities", "distrust of mainstream institutions"],
    relatedArchetypes: ["populist", "institutional_skeptic"],
  },
  {
    key: "pro_establishment",
    name: "Pro-Establishment",
    description: "Supportive of the governing authorities and mainstream institutions",
    indicators: ["support for the governing authorities", "defense of mainstream institutions"],
    relatedArchetypes: ["pragmatic_centrist", "globalist"],
  },
  {
    key: "progressive_reformer",
    name: "Progressive / Reformer",
    description: "Advocates progressive change and policy reform",
    indicators: ["calls for reform", "support for progressive policy"],
    relatedArchetypes: ["social_justice", "anti_establishment"],
  },
  {
    key: "social_conservative",
    name: "Social Conservative / Traditionalist",
    description: "Emphasises tradition and conventional social values",
    indicators: ["appeals to tradition", "defense of conventional social values"],
    relatedArchetypes: ["anti_woke", "nationalist"],
  },
  {
    key: "populist",
    name: "Populist",
    description: "Frames politics as ordinary people versus a self-serving elite",
    indicators: ["anti-elite rhetoric", "ordinary-people-first framing"],
    relatedArchetypes: ["anti_establishment", "nationalist"],
  },
  {
    key: "nationalist",
    name: "Nationalist / Citizens-First",
    description: "Emphasises national identity and citizens-first arguments",
    indicators: ["national identity emphasis", "citizens-first arguments"],
    relatedArchetypes: ["populist", "social_conservative"],
  },
  {
    key: "globalist",
    name: "Globalist / Cosmopolitan",
    description: "Supportive of immigration, openness and globalisation",
    indicators: ["support for immigration", "support for globalisation"],
    relatedArchetypes: ["pro_establishment", "progressive_reformer"],
  },
  {
    key: "economic_grievance",
    name: "Economic Grievance / Cost-of-Living",
    description: "Focused on affordability, wages and economic decline",
    indicators: ["cost-of-living concerns", "economic decline narratives"],
    relatedArchetypes: ["populist", "anti_establishment"],
  },
  {
    key: "free_speech",
    name: "Free Speech / Anti-Censorship",
    description: "Opposed to content moderation and supportive of unrestricted discussion",
    indicators: ["opposition to moderation", "support for unrestricted discussion"],
    relatedArchetypes: ["anti_woke", "institutional_skeptic"],
  },
  {
    key: "anti_woke",
    name: "Anti-Identity-Politics",
    description: "Critical of identity politics and progressive activism",
    indicators: ["criticism of identity politics", "criticism of progressive activism"],
    relatedArchetypes: ["social_conservative", "free_speech"],
  },
  {
    key: "social_justice",
    name: "Social Justice Advocate",
    description: "Supports equity, minority rights and activist causes",
    indicators: ["support for equity and minority rights", "support for activist causes"],
    relatedArchetypes: ["progressive_reformer", "globalist"],
  },
  {
    key: "institutional_skeptic",
    name: "Institutional Skeptic",
    description: "Distrustful of official narratives, media and institutions",
    indicators: ["distrust of official narratives", "distrust of mainstream media"],
    relatedArchetypes: ["anti_establishment", "free_speech"],
  },
  {
    key: "pragmatic_centrist",
    name: "Pragmatic Centrist",
    description: "Balanced, policy-first discussions mixing praise and criticism",
    indicators: ["mixed praise and criticism", "policy-first discussions"],
    relatedArchetypes: ["pro_establishment", "globalist"],
  },
  {
    key: "mixed_unclassified",
    name: "Mixed / Unclassified",
    description: "No clear dominant themes; diverse discussion patterns",
    indicators: ["no clear dominant themes"],
    relatedArchetypes: [],
  },
];

export type ArchetypeKey = string;

export function getArchetype(key: string) {
  return ARCHETYPES.find((a) => a.key === key);
}

/**
 * Replace the active taxonomy in place so every module that imported the
 * ARCHETYPES reference observes the update without needing to re-import.
 */
export function applyArchetypes(list: Archetype[]): void {
  ARCHETYPES.splice(0, ARCHETYPES.length, ...list);
}

/**
 * Load a previously derived taxonomy from the DB if one has been saved,
 * otherwise keep the default shipped above. Called once at server startup.
 */
function isArchetype(x: unknown): x is Archetype {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    typeof r.name === "string" &&
    typeof r.description === "string" &&
    Array.isArray(r.indicators) &&
    r.indicators.every((i) => typeof i === "string") &&
    Array.isArray(r.relatedArchetypes) &&
    r.relatedArchetypes.every((i) => typeof i === "string")
  );
}

export async function loadArchetypesFromDb(): Promise<void> {
  const raw = await getSetting(SETTING_ARCHETYPES);
  if (!raw) return;
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isArchetype)) {
    applyArchetypes(parsed);
  }
}
