import { useState } from "react";
import type { Identifier, IdentifierSource } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Fingerprint,
  Quote,
  ExternalLink,
  ChevronDown,
  AlertTriangle,
  User,
  MapPin,
  Briefcase,
  GraduationCap,
  Heart,
  Tag,
  Clock,
  Calendar,
  AtSign,
  Home,
  Plane,
  Landmark,
} from "lucide-react";

/* ---------------------------------------------------------------------------
 * Grouping: map the backend's flat categories into human dossier sections.
 * Any category not listed falls through to "Other".
 * ------------------------------------------------------------------------- */
const GROUPS: { key: string; icon: typeof User; categories: string[] }[] = [
  { key: "Demographics", icon: User, categories: ["Name", "Age", "Date of Birth", "Gender", "Nationality", "Race/Ethnicity", "Religion"] },
  {
    key: "Location",
    icon: MapPin,
    categories: [
      "Possible Address",
      "Residence",
      "Previous Residence",
      "Workplace Location",
      "School Location",
      "Frequent Location",
      "Country",
      "State/Province",
      "City",
      "Neighborhood",
      "Location",
    ],
  },
  { key: "Employment", icon: Briefcase, categories: ["Occupation", "Employer", "Employment Status"] },
  {
    key: "Education",
    icon: GraduationCap,
    // "Education" (legacy generic) kept for backward-compatible older analyses.
    categories: ["School", "University", "Course of Study", "Graduation Year", "Education"],
  },
  { key: "Relationships", icon: Heart, categories: ["Relationship Status", "Family"] },
  { key: "Assets & Lifestyle", icon: Home, categories: ["Housing", "Vehicle", "Financial"] },
  { key: "Travel", icon: Plane, categories: ["Travel History"] },
  { key: "Affiliations", icon: Landmark, categories: ["Affiliations"] },
  {
    key: "Contact & Social",
    icon: AtSign,
    categories: ["Email", "Phone", "Telegram", "Discord", "Instagram", "X/Twitter", "TikTok", "LinkedIn", "GitHub", "Website"],
  },
  { key: "Other", icon: Tag, categories: ["Military Service", "Languages", "Other"] },
];

// Singular attributes: a person has exactly one true value at a time, so two
// distinct *reconciled* values mean a genuine contradiction worth flagging.
// Multi-valued categories (Languages, lived-in Locations, Race/Ethnicity) are
// NOT flagged.
const SINGULAR = new Set(["Age", "Date of Birth", "Gender", "Nationality", "Relationship Status", "Employment Status", "Housing", "Religion"]);

// Categories that can legitimately hold several COMPATIBLE values at once
// (mixed heritage / multiple self-descriptions, e.g. "Kurdish" + "indigenous
// minority" + "not Chinese" all describe one person). These collapse into a
// single combined entry and are never flagged as conflicts.
const MULTI_VALUE_COMBINE = new Set(["Race/Ethnicity"]);

// Faith clusters: different words that describe the SAME religion. A Muslim who
// is also a "revert" (convert to Islam), "Sunni", etc. is ONE faith, not a
// contradiction. Values in the same cluster consolidate into one canonical
// entry; only genuinely different faiths (e.g. Muslim vs Christian) conflict.
const RELIGION_CLUSTERS: { canonical: string; terms: string[] }[] = [
  {
    canonical: "Muslim",
    terms: ["muslim", "muslimah", "islam", "islamic", "revert", "reverted", "sunni", "shia", "shi'a", "shiite", "sufi", "ahmadi", "ahmadiyya"],
  },
  {
    canonical: "Christian",
    terms: ["christian", "catholic", "roman catholic", "protestant", "evangelical", "baptist", "methodist", "presbyterian", "lutheran", "anglican", "pentecostal", "orthodox christian", "mormon", "lds", "born again"],
  },
  { canonical: "Jewish", terms: ["jewish", "jew", "judaism", "orthodox jew"] },
  { canonical: "Hindu", terms: ["hindu", "hinduism"] },
  { canonical: "Buddhist", terms: ["buddhist", "buddhism"] },
  { canonical: "Sikh", terms: ["sikh", "sikhism"] },
  { canonical: "Atheist", terms: ["atheist", "atheism"] },
  { canonical: "Agnostic", terms: ["agnostic", "agnosticism"] },
];

// Map a Religion value to its canonical faith, or null when unrecognized (kept
// as its own distinct value so real conflicts still surface).
function canonicalReligion(value: string): string | null {
  const norm = value.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  const words = new Set(norm.split(" "));
  for (const c of RELIGION_CLUSTERS) {
    if (c.terms.some((t) => (t.includes(" ") ? norm.includes(t) : words.has(t)))) return c.canonical;
  }
  return null;
}

// Categories whose values should be grouped by a canonical normalizer before
// conflict detection (synonyms merge; distinct canonicals conflict).
const CLUSTER_NORMALIZERS: Record<string, (v: string) => string | null> = {
  Religion: canonicalReligion,
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function fmtMonthYear(iso: string | null | undefined): string {
  if (!iso) return "Date unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Date unknown";
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

function fmtFullDate(iso: string | null | undefined): string {
  if (!iso) return "Date unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Date unknown";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

/** Most recent postedAt across an identifier's sources (ISO string or null). */
function lastObserved(sources: IdentifierSource[]): string | null {
  let best: number | null = null;
  for (const s of sources) {
    if (!s.postedAt) continue;
    const t = new Date(s.postedAt).getTime();
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

/** Mid-points for decade words ("in my forties" -> ~45). */
const DECADE_WORDS: Record<string, number> = {
  teens: 16,
  twenties: 25,
  thirties: 35,
  forties: 45,
  fifties: 55,
  sixties: 65,
  seventies: 75,
  eighties: 85,
  nineties: 95,
};

/**
 * Parse an Age value into number + reference date. Handles both explicit ages
 * ("23 (as of Jul 2024)") and decade words ("in my forties (as of Jun 2026)").
 */
function parseAge(value: string): { age: number; asOf: Date | null; decade: boolean } | null {
  // Extract the "as of <date>" reference FIRST, then strip it so its digits
  // (e.g. the year "2026") can't be misread as the age.
  let asOf: Date | null = null;
  const md = value.match(/as of\s+([A-Za-z]{3,9})\s+(\d{4})/i);
  if (md) {
    const mi = MONTHS.indexOf(md[1].slice(0, 3).toLowerCase());
    if (mi >= 0) asOf = new Date(Date.UTC(Number(md[2]), mi, 1));
  } else {
    const y = value.match(/as of\s+(\d{4})/i);
    if (y) asOf = new Date(Date.UTC(Number(y[1]), 0, 1));
  }
  const stripped = value.replace(/\(?\s*as of[^)]*\)?/i, " ");
  const lower = stripped.toLowerCase();

  let age: number | null = null;
  const decade = lower.match(
    /\b(teens|twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/,
  );
  if (decade) {
    age = DECADE_WORDS[decade[1]];
    if (/\bearly\b/.test(lower)) age -= 3;
    else if (/\blate\b/.test(lower)) age += 3;
  } else {
    const m = stripped.match(/\b(\d{1,3})\b/);
    if (m) age = Number(m[1]);
  }

  if (age === null || !Number.isFinite(age) || age <= 0 || age > 120) return null;
  return { age, asOf, decade: Boolean(decade) };
}

interface AgeSummary {
  estimate: number | null;
  birthYears: number[];
  conflict: boolean;
  // True when the anchoring disclosure was a decade ("in my forties") rather
  // than an exact age — render as a band ("40s") instead of a point estimate.
  approximate: boolean;
}

/** Reconcile every Age disclosure to a birth year and estimate current age. */
function summarizeAge(ageEntries: Identifier[]): AgeSummary {
  const births: { year: number; asOf: Date; decade: boolean }[] = [];
  for (const e of ageEntries) {
    const p = parseAge(e.value);
    if (p && p.asOf) births.push({ year: p.asOf.getFullYear() - p.age, asOf: p.asOf, decade: p.decade });
  }
  if (births.length === 0) return { estimate: null, birthYears: [], conflict: false, approximate: false };
  const years = births.map((b) => b.year);
  const conflict = Math.max(...years) - Math.min(...years) > 1;
  // Use the most recent disclosure as the most reliable birth-year anchor.
  const anchor = births.reduce((a, b) => (b.asOf > a.asOf ? b : a));
  const estimate = new Date().getUTCFullYear() - anchor.year;
  return { estimate, birthYears: Array.from(new Set(years)), conflict, approximate: anchor.decade };
}

/** Display string for the age estimate: "40s" for decades, "≈ 45" otherwise. */
function ageDisplayValue(s: AgeSummary): string | null {
  if (s.estimate === null) return null;
  return s.approximate ? `${Math.floor(s.estimate / 10) * 10}s` : `≈ ${s.estimate}`;
}

/** Pick the freshest single value for a category (for the summary band). */
function freshestValue(entries: Identifier[]): string | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => {
    const ta = new Date(lastObserved(a.sources) ?? 0).getTime();
    const tb = new Date(lastObserved(b.sources) ?? 0).getTime();
    return tb - ta;
  });
  return sorted[0].value;
}

/* ---------------------------------------------------------------------------
 * Consolidation: collapse overlapping identifiers within a category into one
 * canonical entry, keeping the overlapping statements as supporting sources.
 *  - Age      -> single "current estimate" entry; every stated age is a source.
 *  - Negative statements ("Not American") fold into a positive value when one
 *    exists ("Canadian").
 *  - A less specific value ("Engineer") folds into a more specific one that
 *    contains it ("Software Engineer").
 * Genuinely distinct values (two different nationalities) stay separate so the
 * conflict flag still fires.
 * ------------------------------------------------------------------------- */
function isNegativeValue(v: string): boolean {
  // Explicit negation only ("Not American", "not from the US").
  // Must NOT catch legitimate identities like "non-binary".
  return /\bnot\b/i.test(v);
}

function toTokens(v: string): string[] {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// True when every word of `shorter` also appears in `longer` (word-boundary
// aware), i.e. `longer` is a strictly more specific phrase. Prevents accidental
// substring merges like "female" absorbing "male".
function isMoreSpecific(shorter: string, longer: string): boolean {
  const longTokens = new Set(toTokens(longer));
  const shortTokens = toTokens(shorter);
  if (shortTokens.length === 0 || shortTokens.length >= longTokens.size) return false;
  return shortTokens.every((t) => longTokens.has(t));
}

function dedupeSources(sources: IdentifierSource[]): IdentifierSource[] {
  const seen = new Set<string>();
  const out: IdentifierSource[] = [];
  for (const s of sources) {
    const k = `${s.permalink ?? ""}::${s.quote}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.sort((a, b) => new Date(b.postedAt ?? 0).getTime() - new Date(a.postedAt ?? 0).getTime());
}

function mergeEntries(category: string, value: string, entries: Identifier[]): Identifier {
  return { category, value, sources: dedupeSources(entries.flatMap((e) => e.sources)) };
}

function consolidateCategory(category: string, entries: Identifier[], ageDisplay: string | null): Identifier[] {
  if (entries.length <= 1) return entries;

  if (category === "Age") {
    const value = ageDisplay !== null ? `${ageDisplay} (current est.)` : (freshestValue(entries) ?? entries[0].value);
    return [mergeEntries(category, value, entries)];
  }

  const positives = entries.filter((e) => !isNegativeValue(e.value));
  const negatives = entries.filter((e) => isNegativeValue(e.value));

  // Only negatives -> keep one entry carrying all the negative statements.
  if (positives.length === 0) return [mergeEntries(category, entries[0].value, entries)];

  // Group positives by specificity: longest value is canonical; a strictly
  // less specific phrase (all its words appear in the canonical) folds in.
  const sorted = [...positives].sort((a, b) => b.value.length - a.value.length);
  const groups: { canonical: string; members: Identifier[] }[] = [];
  for (const e of sorted) {
    // Canonical is always the longer phrase (sorted desc), so this entry can
    // only fold in if it is a strictly less specific subset of the canonical.
    const g = groups.find((gr) => isMoreSpecific(e.value, gr.canonical));
    if (g) g.members.push(e);
    else groups.push({ canonical: e.value, members: [e] });
  }

  // Genuinely multi-valued, compatible attributes (e.g. ethnicity): merge every
  // distinct positive into one entry, keeping all statements (incl. negations)
  // as supporting evidence. No conflict — these describe the same person.
  if (MULTI_VALUE_COMBINE.has(category)) {
    const value = groups.map((g) => g.canonical).join(", ");
    const members = [...groups.flatMap((g) => g.members), ...negatives];
    return [mergeEntries(category, value, members)];
  }

  // Categories with a canonical normalizer (e.g. Religion): group positives by
  // their canonical value so synonyms ("Muslim" + "revert") merge into a single
  // entry. Only genuinely distinct canonicals remain separate (a real conflict).
  const normalize = CLUSTER_NORMALIZERS[category];
  if (normalize) {
    const faithGroups = new Map<string, { canonical: string; members: Identifier[] }>();
    for (const e of positives) {
      const faith = normalize(e.value);
      const key = faith ?? `raw:${e.value.toLowerCase().trim()}`;
      const existing = faithGroups.get(key);
      if (existing) existing.members.push(e);
      else faithGroups.set(key, { canonical: faith ?? e.value, members: [e] });
    }
    const fg = [...faithGroups.values()];
    if (fg.length === 1) {
      return [mergeEntries(category, fg[0].canonical, [...fg[0].members, ...negatives])];
    }
    const result = fg.map((g) => mergeEntries(category, g.canonical, g.members));
    if (negatives.length) result.push(mergeEntries(category, negatives[0].value, negatives));
    return result;
  }

  // Single distinct positive -> negatives become supporting evidence for it.
  if (groups.length === 1) {
    return [mergeEntries(category, groups[0].canonical, [...groups[0].members, ...negatives])];
  }

  // Multiple genuinely distinct positives -> keep separate (conflict); park any
  // negative statements in their own entry rather than guessing an owner.
  const result = groups.map((g) => mergeEntries(category, g.canonical, g.members));
  if (negatives.length) result.push(mergeEntries(category, negatives[0].value, negatives));
  return result;
}

function SummaryChip({ icon: Icon, label, value, estimated }: { icon: typeof User; label: string; value: string; estimated?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/10 px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="truncate text-sm font-semibold text-foreground">
          {value}
          {estimated && <span className="ml-1 text-[10px] font-normal text-muted-foreground">est.</span>}
        </div>
      </div>
    </div>
  );
}

function IdentifierRow({ entry, flagConflict }: { entry: Identifier; flagConflict: boolean }) {
  const [open, setOpen] = useState(false);
  const observed = lastObserved(entry.sources);
  const count = entry.sources.length;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-md border border-border/50 bg-muted/5 px-3 py-2.5 text-left transition-colors hover:bg-muted/15">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{entry.category}</span>
            {flagConflict && (
              <Badge variant="outline" className="border-amber-500/40 text-amber-500 gap-1 px-1.5 py-0 text-[9px]">
                <AlertTriangle className="h-2.5 w-2.5" /> CONFLICT
              </Badge>
            )}
          </div>
          <div className="truncate text-sm font-semibold text-foreground">{entry.value}</div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          {observed && (
            <span className="hidden items-center gap-1 sm:flex" title="Last observed">
              <Clock className="h-3 w-3" /> {fmtMonthYear(observed)}
            </span>
          )}
          <span className="rounded bg-muted/30 px-1.5 py-0.5 font-mono">
            {count} {count === 1 ? "source" : "sources"}
          </span>
          <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 px-3 pb-3 pt-2">
          {entry.sources.map((src, j) => (
            <div key={j} className="rounded-md border-l-2 border-primary/30 bg-muted/10 px-3 py-2">
              <div className="flex items-start gap-1.5 text-xs italic text-muted-foreground">
                <Quote className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
                <span className="break-words">"{src.quote}"</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <Badge variant="secondary" className="px-1.5 py-0 text-[9px] uppercase">
                  {src.sourceType}
                </Badge>
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> {fmtFullDate(src.postedAt)}
                </span>
                {src.permalink && (
                  <a
                    href={src.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
                  >
                    view {src.sourceType} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function IdentityDossier({ identifiers }: { identifiers: Identifier[] | undefined }) {
  const list = identifiers ?? [];

  const rawByCategory = (cat: string) => list.filter((i) => i.category === cat);
  const ageSummary = summarizeAge(rawByCategory("Age"));

  // Consolidate overlapping identifiers within each category before rendering.
  const allCategories = Array.from(new Set(list.map((i) => i.category)));
  const consolidated = allCategories.flatMap((cat) =>
    consolidateCategory(cat, rawByCategory(cat), cat === "Age" ? ageDisplayValue(ageSummary) : null),
  );
  const byCategory = (cat: string) => consolidated.filter((i) => i.category === cat);

  // Identity summary band — only show attributes that exist.
  const summaryChips: { icon: typeof User; label: string; value: string; estimated?: boolean }[] = [];
  if (ageSummary.estimate !== null) {
    summaryChips.push({ icon: User, label: "Age", value: ageDisplayValue(ageSummary) ?? "", estimated: true });
  }
  const gender = freshestValue(byCategory("Gender"));
  if (gender) summaryChips.push({ icon: User, label: "Gender", value: gender });
  // Prefer the most useful single location for the summary band: where they
  // live, then increasingly coarse geography, falling back to legacy "Location".
  const location =
    freshestValue(byCategory("Possible Address")) ??
    freshestValue(byCategory("Residence")) ??
    freshestValue(byCategory("City")) ??
    freshestValue(byCategory("Neighborhood")) ??
    freshestValue(byCategory("Country")) ??
    freshestValue(byCategory("Location"));
  if (location) summaryChips.push({ icon: MapPin, label: "Location", value: location });
  const occupation = freshestValue(byCategory("Occupation"));
  if (occupation) summaryChips.push({ icon: Briefcase, label: "Occupation", value: occupation });

  // Build groups, attaching any unmapped categories to "Other".
  const mapped = new Set(GROUPS.flatMap((g) => g.categories));
  const groups = GROUPS.map((g) => {
    const cats = g.key === "Other" ? [...g.categories, ...consolidated.map((i) => i.category).filter((c) => !mapped.has(c))] : g.categories;
    const entries = consolidated.filter((i) => cats.includes(i.category));
    return { ...g, entries };
  }).filter((g) => g.entries.length > 0);

  // Conflict detection per category (singular attributes that survive
  // consolidation as >1 distinct value).
  const conflictedCategories = new Set<string>();
  for (const cat of SINGULAR) {
    const entries = byCategory(cat);
    if (cat === "Age") {
      if (ageSummary.conflict) conflictedCategories.add(cat);
    } else {
      const distinct = new Set(entries.map((e) => e.value.toLowerCase().trim()));
      if (distinct.size > 1) conflictedCategories.add(cat);
    }
  }

  return (
    <Card className="glass border-primary/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-mono text-sm tracking-wider text-muted-foreground">
          <Fingerprint className="h-4 w-4" /> IDENTITY DOSSIER
        </CardTitle>
        <CardDescription className="text-xs">
          Self-disclosed attributes consolidated from the user's own posts and comments. Every value is traceable to its
          original source.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {list.length === 0 ? (
          <p className="font-mono text-sm text-muted-foreground">
            No self-disclosed identifiers detected. Run an analysis to extract them.
          </p>
        ) : (
          <>
            {summaryChips.length > 0 && (
              <div>
                <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  Identity summary
                </div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {summaryChips.map((c, i) => (
                    <SummaryChip key={i} {...c} />
                  ))}
                </div>
                {ageSummary.estimate !== null && (
                  <p className="mt-1.5 text-[10px] text-muted-foreground/70">
                    Age is estimated from the most recent disclosure; expand the Age entry for the original statements.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.key}>
                  <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-foreground/80">
                    <g.icon className="h-3.5 w-3.5 text-primary" /> {g.key}
                  </div>
                  <div className="space-y-1.5">
                    {g.entries.map((entry, i) => (
                      <IdentifierRow
                        key={`${entry.category}-${entry.value}-${i}`}
                        entry={entry}
                        flagConflict={conflictedCategories.has(entry.category)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
