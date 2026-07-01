import { openai } from "@workspace/integrations-openai-ai-server";
import { jsonrepair } from "jsonrepair";
import type { IdentifierEntry } from "@workspace/db";
import { ARCHETYPES } from "./archetypes";
import { logger } from "./logger";
import { recordOpenAiCost } from "./cost-tracking";

/**
 * Robustly extract and parse a JSON object from a model response.
 *
 * Even with `response_format: { type: "json_object" }` the model occasionally
 * emits subtly malformed JSON — a missing comma between array elements, an
 * unescaped newline inside a string, or a markdown fence wrapper. A single
 * `JSON.parse` on a naive `/\{[\s\S]*\}/` match throws on any of these and
 * loses the whole run (an expensive crawl). This isolates the outermost
 * object, tries a plain parse, and falls back to `jsonrepair` (which fixes
 * missing/trailing commas, unescaped control chars, fences, etc.) before
 * giving up with a clear message.
 */
function parseAiJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const raw = start !== -1 && end !== -1 && end >= start ? candidate.slice(start, end + 1) : candidate.trim();

  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      return JSON.parse(jsonrepair(raw)) as T;
    } catch (err) {
      throw new Error(
        `Model returned malformed JSON that could not be parsed${err instanceof Error ? `: ${err.message}` : ""}`,
      );
    }
  }
}

/**
 * Pull the assistant message text out of a chat completion, but fail loudly if
 * the model was cut off by the token limit (`finish_reason === "length"`).
 * Without this, `jsonrepair` would happily auto-close a truncated object and we
 * would persist a silently-incomplete report. Treating a cutoff as an error
 * keeps it retriable instead.
 *
 * Thrown specifically when the model stopped because it hit its output token cap
 * (`finish_reason === "length"`), as opposed to any other failure. The topic
 * classifier catches this to split an oversized batch in half and retry, so a
 * large run never fails outright on a single too-big batch.
 */
class TokenLimitError extends Error {}

function extractCompletionText(response: {
  model?: string;
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null } | null;
  choices: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>;
}): string {
  // Record estimated OpenAI cost for every completion (including cut-off ones —
  // the tokens were still consumed), attributed via the current cost context.
  recordOpenAiCost(response);
  const choice = response.choices[0];
  if (choice?.finish_reason === "length") {
    throw new TokenLimitError(
      "Model response was cut off before the JSON finished (token limit reached). Retry, or reduce the volume of comments.",
    );
  }
  return choice?.message?.content ?? "";
}

export interface ArchetypeResult {
  score: number;
  confidence: number;
  evidence: string[];
}

export interface AnalysisResult {
  archetypes: Record<string, ArchetypeResult>;
  dominant_archetypes: string[];
  summary: string;
  recurring_themes: string[];
  theme_labels: string[];
  confidence_notes: string;
}

export async function analyzeUserContent(
  username: string,
  posts: Array<{ title: string; body?: string | null }>,
  comments: Array<{ body: string }>,
): Promise<AnalysisResult> {
  const contentSample = [
    ...posts.slice(0, 20).map((p) => `[POST] ${p.title}${p.body ? ": " + p.body.slice(0, 200) : ""}`),
    ...comments.slice(0, 80).map((c) => `[COMMENT] ${c.body.slice(0, 300)}`),
  ].join("\n\n");

  if (!contentSample.trim()) {
    return buildEmptyResult();
  }

  const archetypeKeys = ARCHETYPES.map((a) => a.key);
  const archetypeList = ARCHETYPES.map((a) => `- ${a.key}: ${a.name} (${a.indicators.join(", ")})`).join("\n");

  const prompt = `You are analyzing a Reddit user's public comments and posts from an online community.

Your task is to estimate which discussion archetypes best describe the recurring themes in their content.

IMPORTANT ETHICS RULES:
- Analyze only expressed opinions and discussion themes
- Do NOT infer: race, ethnicity, religion, nationality, occupation, income, medical conditions, mental health, or protected characteristics
- Classifications are probabilistic estimates only

Available archetypes:
${archetypeList}

User content sample:
${contentSample.slice(0, 6000)}

Return ONLY valid JSON in this exact format:
{
  "archetypes": {
${archetypeKeys.map((k) => `    "${k}": { "score": 0, "confidence": 0, "evidence": [] }`).join(",\n")}
  },
  "dominant_archetypes": [],
  "summary": "",
  "recurring_themes": [],
  "theme_labels": [],
  "confidence_notes": ""
}

Scores and confidence are 0-100. Evidence should be 1-3 brief quoted phrases or paraphrases from the content. dominant_archetypes should list keys with score > 40. Keep summary to 2-3 sentences.

For recurring_themes: 3-5 elaborated descriptions of the user's main discussion themes — these appear on their profile page, so be specific and descriptive.
For theme_labels: 3-5 SHORT canonical topic labels (2-4 words, title-case) drawn from the same themes, suitable for cross-user aggregation — e.g. "Cost of Living", "Immigration Policy", "Race Relations", "Housing Affordability", "Political Critique", "National Identity", "Foreign Workers", "Government Policy", "Social Inequality", "Online Discourse". Use consistent phrasing that will match across users.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractCompletionText(response);

    const parsed = parseAiJson<AnalysisResult>(text);
    return parsed;
  } catch (err) {
    // Re-throw so callers can treat this as a transient failure and retry on a
    // future run, rather than persisting a fallback result that would
    // permanently mark the user as "analyzed" with empty/incorrect data.
    logger.error({ err, username }, "Failed to analyze user content");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function analyzeFacebookUserContent(
  displayName: string,
  posts: Array<{ title?: string | null; text?: string | null }>,
  comments: Array<{ body: string }>,
): Promise<AnalysisResult> {
  const contentSample = [
    ...posts.slice(0, 20).map((p) => `[POST] ${p.title ?? ""}${p.text ? ": " + p.text.slice(0, 200) : ""}`),
    ...comments.slice(0, 80).map((c) => `[COMMENT] ${c.body.slice(0, 300)}`),
  ].join("\n\n");

  if (!contentSample.trim()) {
    return buildEmptyResult();
  }

  const archetypeKeys = ARCHETYPES.map((a) => a.key);
  const archetypeList = ARCHETYPES.map((a) => `- ${a.key}: ${a.name} (${a.indicators.join(", ")})`).join("\n");

  const prompt = `You are analyzing a Facebook user's public comments and posts from online community discussions.

Your task is to estimate which discussion archetypes best describe the recurring themes in their content.

IMPORTANT ETHICS RULES:
- Analyze only expressed opinions and discussion themes
- Do NOT infer: race, ethnicity, religion, nationality, occupation, income, medical conditions, mental health, or protected characteristics
- Classifications are probabilistic estimates only

Available archetypes:
${archetypeList}

User content sample:
${contentSample.slice(0, 6000)}

Return ONLY valid JSON in this exact format:
{
  "archetypes": {
${archetypeKeys.map((k) => `    "${k}": { "score": 0, "confidence": 0, "evidence": [] }`).join(",\n")}
  },
  "dominant_archetypes": [],
  "summary": "",
  "recurring_themes": [],
  "theme_labels": [],
  "confidence_notes": ""
}

Scores and confidence are 0-100. Evidence should be 1-3 brief quoted phrases or paraphrases from the content. dominant_archetypes should list keys with score > 40. Keep summary to 2-3 sentences.

For recurring_themes: 3-5 elaborated descriptions of the user's main discussion themes — these appear on their profile, so be specific and descriptive.
For theme_labels: 3-5 SHORT canonical topic labels (2-4 words, title-case) drawn from the same themes, suitable for cross-user aggregation — e.g. "Cost of Living", "Immigration Policy", "Race Relations", "Housing Affordability", "Political Critique", "National Identity", "Foreign Workers", "Government Policy", "Social Inequality", "Online Discourse". Use consistent phrasing that will match across users.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractCompletionText(response);

    const parsed = parseAiJson<AnalysisResult>(text);
    return parsed;
  } catch (err) {
    logger.error({ err, displayName }, "Failed to analyze Facebook user content");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function analyzeInstagramUserContent(
  displayName: string,
  posts: Array<{ title?: string | null; text?: string | null }>,
  comments: Array<{ body: string }>,
): Promise<AnalysisResult> {
  const contentSample = [
    ...posts.slice(0, 20).map((p) => `[POST] ${p.title ?? ""}${p.text ? ": " + p.text.slice(0, 200) : ""}`),
    ...comments.slice(0, 80).map((c) => `[COMMENT] ${c.body.slice(0, 300)}`),
  ].join("\n\n");

  if (!contentSample.trim()) {
    return buildEmptyResult();
  }

  const archetypeKeys = ARCHETYPES.map((a) => a.key);
  const archetypeList = ARCHETYPES.map((a) => `- ${a.key}: ${a.name} (${a.indicators.join(", ")})`).join("\n");

  const prompt = `You are analyzing an Instagram user's public comments and posts from online community discussions.

Your task is to estimate which discussion archetypes best describe the recurring themes in their content.

IMPORTANT ETHICS RULES:
- Analyze only expressed opinions and discussion themes
- Do NOT infer: race, ethnicity, religion, nationality, occupation, income, medical conditions, mental health, or protected characteristics
- Classifications are probabilistic estimates only

Available archetypes:
${archetypeList}

User content sample:
${contentSample.slice(0, 6000)}

Return ONLY valid JSON in this exact format:
{
  "archetypes": {
${archetypeKeys.map((k) => `    "${k}": { "score": 0, "confidence": 0, "evidence": [] }`).join(",\n")}
  },
  "dominant_archetypes": [],
  "summary": "",
  "recurring_themes": [],
  "theme_labels": [],
  "confidence_notes": ""
}

Scores and confidence are 0-100. Evidence should be 1-3 brief quoted phrases or paraphrases from the content. dominant_archetypes should list keys with score > 40. Keep summary to 2-3 sentences.

For recurring_themes: 3-5 elaborated descriptions of the user's main discussion themes — these appear on their profile, so be specific and descriptive.
For theme_labels: 3-5 SHORT canonical topic labels (2-4 words, title-case) drawn from the same themes, suitable for cross-user aggregation — e.g. "Cost of Living", "Immigration Policy", "Race Relations", "Housing Affordability", "Political Critique", "National Identity", "Foreign Workers", "Government Policy", "Social Inequality", "Online Discourse". Use consistent phrasing that will match across users.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractCompletionText(response);

    const parsed = parseAiJson<AnalysisResult>(text);
    return parsed;
  } catch (err) {
    logger.error({ err, displayName }, "Failed to analyze Instagram user content");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function analyzeTwitterUserContent(
  displayName: string,
  posts: Array<{ title?: string | null; text?: string | null }>,
  comments: Array<{ body: string }>,
): Promise<AnalysisResult> {
  const contentSample = [
    ...posts.slice(0, 20).map((p) => `[POST] ${p.title ?? ""}${p.text ? ": " + p.text.slice(0, 200) : ""}`),
    ...comments.slice(0, 80).map((c) => `[COMMENT] ${c.body.slice(0, 300)}`),
  ].join("\n\n");

  if (!contentSample.trim()) {
    return buildEmptyResult();
  }

  const archetypeKeys = ARCHETYPES.map((a) => a.key);
  const archetypeList = ARCHETYPES.map((a) => `- ${a.key}: ${a.name} (${a.indicators.join(", ")})`).join("\n");

  const prompt = `You are analyzing a Twitter/X user's public replies and posts from online community discussions.

Your task is to estimate which discussion archetypes best describe the recurring themes in their content.

IMPORTANT ETHICS RULES:
- Analyze only expressed opinions and discussion themes
- Do NOT infer: race, ethnicity, religion, nationality, occupation, income, medical conditions, mental health, or protected characteristics
- Classifications are probabilistic estimates only

Available archetypes:
${archetypeList}

User content sample:
${contentSample.slice(0, 6000)}

Return ONLY valid JSON in this exact format:
{
  "archetypes": {
${archetypeKeys.map((k) => `    "${k}": { "score": 0, "confidence": 0, "evidence": [] }`).join(",\n")}
  },
  "dominant_archetypes": [],
  "summary": "",
  "recurring_themes": [],
  "theme_labels": [],
  "confidence_notes": ""
}

Scores and confidence are 0-100. Evidence should be 1-3 brief quoted phrases or paraphrases from the content. dominant_archetypes should list keys with score > 40. Keep summary to 2-3 sentences.

For recurring_themes: 3-5 elaborated descriptions of the user's main discussion themes — these appear on their profile, so be specific and descriptive.
For theme_labels: 3-5 SHORT canonical topic labels (2-4 words, title-case) drawn from the same themes, suitable for cross-user aggregation — e.g. "Cost of Living", "Immigration Policy", "Race Relations", "Housing Affordability", "Political Critique", "National Identity", "Foreign Workers", "Government Policy", "Social Inequality", "Online Discourse". Use consistent phrasing that will match across users.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractCompletionText(response);

    const parsed = parseAiJson<AnalysisResult>(text);
    return parsed;
  } catch (err) {
    logger.error({ err, displayName }, "Failed to analyze Twitter user content");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function analyzeYoutubeUserContent(
  displayName: string,
  posts: Array<{ title?: string | null; text?: string | null }>,
  comments: Array<{ body: string }>,
): Promise<AnalysisResult> {
  const contentSample = [
    ...posts.slice(0, 20).map((p) => `[POST] ${p.title ?? ""}${p.text ? ": " + p.text.slice(0, 200) : ""}`),
    ...comments.slice(0, 80).map((c) => `[COMMENT] ${c.body.slice(0, 300)}`),
  ].join("\n\n");

  if (!contentSample.trim()) {
    return buildEmptyResult();
  }

  const archetypeKeys = ARCHETYPES.map((a) => a.key);
  const archetypeList = ARCHETYPES.map((a) => `- ${a.key}: ${a.name} (${a.indicators.join(", ")})`).join("\n");

  const prompt = `You are analyzing a YouTube user's public comments on videos from online community discussions.

Your task is to estimate which discussion archetypes best describe the recurring themes in their content.

IMPORTANT ETHICS RULES:
- Analyze only expressed opinions and discussion themes
- Do NOT infer: race, ethnicity, religion, nationality, occupation, income, medical conditions, mental health, or protected characteristics
- Classifications are probabilistic estimates only

Available archetypes:
${archetypeList}

User content sample:
${contentSample.slice(0, 6000)}

Return ONLY valid JSON in this exact format:
{
  "archetypes": {
${archetypeKeys.map((k) => `    "${k}": { "score": 0, "confidence": 0, "evidence": [] }`).join(",\n")}
  },
  "dominant_archetypes": [],
  "summary": "",
  "recurring_themes": [],
  "theme_labels": [],
  "confidence_notes": ""
}

Scores and confidence are 0-100. Evidence should be 1-3 brief quoted phrases or paraphrases from the content. dominant_archetypes should list keys with score > 40. Keep summary to 2-3 sentences.

For recurring_themes: 3-5 elaborated descriptions of the user's main discussion themes — these appear on their profile, so be specific and descriptive.
For theme_labels: 3-5 SHORT canonical topic labels (2-4 words, title-case) drawn from the same themes, suitable for cross-user aggregation — e.g. "Cost of Living", "Immigration Policy", "Race Relations", "Housing Affordability", "Political Critique", "National Identity", "Foreign Workers", "Government Policy", "Social Inequality", "Online Discourse". Use consistent phrasing that will match across users.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractCompletionText(response);

    const parsed = parseAiJson<AnalysisResult>(text);
    return parsed;
  } catch (err) {
    logger.error({ err, displayName }, "Failed to analyze YouTube user content");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function analyzeTikTokUserContent(
  displayName: string,
  posts: Array<{ title?: string | null; text?: string | null }>,
  comments: Array<{ body: string }>,
): Promise<AnalysisResult> {
  const contentSample = [
    ...posts.slice(0, 20).map((p) => `[POST] ${p.title ?? ""}${p.text ? ": " + p.text.slice(0, 200) : ""}`),
    ...comments.slice(0, 80).map((c) => `[COMMENT] ${c.body.slice(0, 300)}`),
  ].join("\n\n");

  if (!contentSample.trim()) {
    return buildEmptyResult();
  }

  const archetypeKeys = ARCHETYPES.map((a) => a.key);
  const archetypeList = ARCHETYPES.map((a) => `- ${a.key}: ${a.name} (${a.indicators.join(", ")})`).join("\n");

  const prompt = `You are analyzing a TikTok user's public comments and posts from online community discussions.

Your task is to estimate which discussion archetypes best describe the recurring themes in their content.

IMPORTANT ETHICS RULES:
- Analyze only expressed opinions and discussion themes
- Do NOT infer: race, ethnicity, religion, nationality, occupation, income, medical conditions, mental health, or protected characteristics
- Classifications are probabilistic estimates only

Available archetypes:
${archetypeList}

User content sample:
${contentSample.slice(0, 6000)}

Return ONLY valid JSON in this exact format:
{
  "archetypes": {
${archetypeKeys.map((k) => `    "${k}": { "score": 0, "confidence": 0, "evidence": [] }`).join(",\n")}
  },
  "dominant_archetypes": [],
  "summary": "",
  "recurring_themes": [],
  "theme_labels": [],
  "confidence_notes": ""
}

Scores and confidence are 0-100. Evidence should be 1-3 brief quoted phrases or paraphrases from the content. dominant_archetypes should list keys with score > 40. Keep summary to 2-3 sentences.

For recurring_themes: 3-5 elaborated descriptions of the user's main discussion themes — these appear on their profile, so be specific and descriptive.
For theme_labels: 3-5 SHORT canonical topic labels (2-4 words, title-case) drawn from the same themes, suitable for cross-user aggregation — e.g. "Cost of Living", "Immigration Policy", "Race Relations", "Housing Affordability", "Political Critique", "National Identity", "Foreign Workers", "Government Policy", "Social Inequality", "Online Discourse". Use consistent phrasing that will match across users.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractCompletionText(response);

    const parsed = parseAiJson<AnalysisResult>(text);
    return parsed;
  } catch (err) {
    logger.error({ err, displayName }, "Failed to analyze TikTok user content");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export interface IdentifierSourceInput {
  sourceType: "post" | "comment";
  text: string;
  permalink: string | null;
  /** When the source was posted, used to anchor time-relative values (e.g. age). */
  postedAt?: Date | null;
}

interface RawIdentifier {
  category?: string;
  value?: string;
  quote?: string;
  sourceIndex?: number;
}

const IDENTIFIER_CATEGORIES = [
  // Demographics
  "Name",
  "Age",
  "Date of Birth",
  "Gender",
  "Nationality",
  "Race/Ethnicity",
  "Religion",
  // Relationship / family / service / language
  "Relationship Status",
  "Family",
  "Military Service",
  "Languages",
  // Education (granular)
  "School",
  "University",
  "Course of Study",
  "Graduation Year",
  // Employment
  "Occupation",
  "Employer",
  "Employment Status",
  // Assets & lifestyle
  "Housing",
  "Vehicle",
  "Financial",
  "Travel History",
  "Affiliations",
  // Location — geographic granularity
  "Country",
  "State/Province",
  "City",
  "Neighborhood",
  // Location — contextual (what the place means to the user)
  "Possible Address",
  "Residence",
  "Previous Residence",
  "Workplace Location",
  "School Location",
  "Frequent Location",
  // Generic location (legacy / fallback when role & granularity are unclear)
  "Location",
  // Contact & social handles (only the user's OWN, explicitly shared)
  "Email",
  "Phone",
  "Telegram",
  "Discord",
  "Instagram",
  "X/Twitter",
  "TikTok",
  "LinkedIn",
  "GitHub",
  "Website",
  // Catch-all
  "Other",
];

/**
 * Extract ONLY explicitly self-disclosed personal identifiers from a user's own
 * posts/comments (age, gender, location, etc.), each backed by a verbatim quote
 * and the source link. This is distinct from archetype analysis (which forbids
 * inferring demographics): here we surface only attributes the user literally
 * stated about themselves, never inferred.
 *
 * The model returns the index of the source item rather than echoing the link
 * (models silently drop/garble long URLs in big arrays); the server resolves
 * the index back to the real permalink, then dedupes by (category, value) while
 * preserving every supporting source.
 */
// Cheap pre-filter: surface items that plausibly contain a first-person
// self-disclosure. The model does the precise extraction, but scanning the
// user's ENTIRE corpus through the LLM is too expensive, and a fixed sample
// (e.g. first 30 posts) silently drops the very items that hold a "23M" or "I
// work as…". Built from sub-patterns for readability; intentionally broad
// (recall over precision — false positives only cost a few tokens, false
// negatives lose evidence). Covers demographics, education, location context,
// AND contact/social handles — the last group is essential: an email/handle/url
// with no other disclosure word would otherwise be filtered out before ever
// reaching the LLM.
const DISCLOSURE_PATTERNS: string[] = [
  // Age / gender markers
  String.raw`\b\d{1,2}\s?[mf]\b`,
  String.raw`\b[mf]\s?\d{1,2}\b`,
  String.raw`\b\d{1,2}\s?(?:yo|y\/o|years?\s?old)\b`,
  // First-person disclosure verbs
  String.raw`\bi['’]?m\b`,
  String.raw`\bi\s?am\b`,
  String.raw`\bi\s+(?:live|stay|grew\s?up|was\s?born|am\s?from|come\s?from|moved|relocated|work|study|studied|graduated|serve|served|hang)\b`,
  // "my <attribute>"
  String.raw`\bmy\s+(?:age|gender|job|work|employer|company|boss|salary|pay|wife|husband|gf|bf|girlfriend|boyfriend|fiance|fiancee|partner|spouse|degree|uni|university|college|school|course|major|country|nationality|race|religion|faith|church|mosque|temple|kids?|son|daughter|e-?mail|number|handle|username|tag|insta|instagram|telegram|discord|tiktok|linkedin|github|twitter|website|blog|portfolio|office|home|hometown|neighbourhood|neighborhood|estate|flat|apartment|condo|house|car|bike|motorbike|gamertag)\b`,
  // Employment / employer / status
  String.raw`\bi\s+(?:work\s+(?:at|for|as)|am\s+(?:employed|unemployed|self-?employed|retired|a\s+student)|got\s+(?:a\s+)?job|quit|resigned|got\s+retrenched|laid\s+off)\b`,
  // Housing / property (first-person framed — bare "condo/flat/apartment" are too
  // common as topical chatter in many corpora and would flood the candidate cap)
  String.raw`\bmy\s+(?:condo|flat|apartment|house|home|place|mortgage|home\s?loan)\b`,
  String.raw`\bi\s+(?:own|rent|bought|am\s+renting)\b|\bi['’]?m\s+renting\b|\bhome\s?owner\b`,
  // Vehicle (first-person framed)
  String.raw`\b(?:i\s+drive|i\s+ride|my\s+(?:car|bike|motorbike))\b`,
  // Financial signals (first-person framed)
  String.raw`\b(?:i\s+earn|i\s+invest|my\s+(?:salary|pay|take-?home|portfolio|savings|net\s?worth))\b|\bi['’]?m?\s+in\s+debt\b`,
  // Religion / faith
  String.raw`\b(?:i\s?am|i['’]?m)\s+(?:a\s+)?(?:christian|catholic|muslim|hindu|buddhist|taoist|sikh|jewish|atheist|agnostic|free\s?thinker|free-?thinker)\b`,
  String.raw`\b(?:my\s+(?:religion|faith|church|mosque|temple)|i\s+(?:pray|attend\s+church|go\s+to\s+(?:church|mosque|temple)))\b`,
  // Travel history (first-person VISITED — "lived in" is left to Location triggers)
  String.raw`\bi\s+(?:visited|travel(?:led|ed)?\s+to|went\s+to|have\s+been\s+to|backpacked|studied\s+abroad)\b`,
  // Affiliations / memberships
  String.raw`\b(?:i['’]?m|i\s?am)\s+(?:a\s+)?member\b|\bi\s+belong\s+to\b|\bi\s+volunteer\b|\bmy\s+(?:club|society|union|cca|party)\b`,
  // Date of birth / birthday
  String.raw`\b(?:my\s+birthday|i\s+was\s+born\s+(?:on|in)\b|born\s+in\s+(?:19|20)\d{2})\b`,
  // Self-naming
  String.raw`\bmy\s+name\b|\bcall\s+me\b|\bi\s+go\s+by\b|\bname['’]s\b|\bgoes\s+by\b`,
  // Demographic / education / military / language / relationship vocabulary
  String.raw`\b(?:male|female|woman|guy|married|single|divorced|engaged|widowed|university|college|diploma|degree|graduated|alumni|matriculated|freshman|sophomore|veteran|army|navy|citizen|permanent\s?resident|immigrant|fluent|bilingual)\b`,
  // Race / ethnicity self-framing (incl. negations & "indigenous minority")
  String.raw`\bas\s+an?\s+(?:non-?\s*)?(?:asian|black|white|latino|hispanic|arab|jewish|african|european|indian|chinese|american|briton)\b`,
  String.raw`\bnon-?\s*(?:asian|black|white|latino|hispanic|arab|african|european|indian|chinese|american|briton)\b`,
  String.raw`\b(?:i['’]?m|i\s?am)\s+(?:an?\s+)?(?:asian|black|white|latino|hispanic|arab|african|european|indian|chinese)\b`,
  String.raw`\bindigenous\b|\bminorit(?:y|ies)\b`,
  // Location context
  String.raw`\b(?:live[sd]?\s+in|stay\s+in|based\s+in|located\s+in|grew\s+up\s+in|moved\s+to|relocated\s+to|work\s+(?:in|at)|study\s+(?:in|at)|office\s+(?:is\s+)?(?:in|at)|hang(?:ing|s)?\s+(?:out|around)|hometown|neighbourhood|neighborhood)\b`,
  // Contact & social
  String.raw`[\w.+-]+@[\w-]+\.[a-z]{2,}`, // email
  String.raw`\b(?:telegram|t\.me\/|discord|instagram|insta|tiktok|linkedin|github|twitter|x\.com)\b`, // platforms
  String.raw`\b(?:dm|pm|add|follow|reach|find|message|contact)\s+me\b`, // sharing cues
  String.raw`@[A-Za-z0-9_]{3,}`, // handle
  String.raw`https?:\/\/`, // url
  String.raw`\+\d[\d\s().-]{6,}\d`, // international phone
  String.raw`\b\d{3}[-.\s]\d{3}[-.\s]?\d{4}\b`, // US-style phone
];
const DISCLOSURE_SIGNAL = new RegExp(DISCLOSURE_PATTERNS.join("|"), "i");

// Strong, rare, high-value markers — these jump to the front of the candidate
// list so they survive the cap even for prolific users (age/gender plus the
// scarce contact disclosures we never want to drop). Deliberately NARROW:
// bare URLs, plain platform mentions, and lone @handles are far too common
// (link-heavy corpora would flood the 150-candidate budget and starve true
// disclosures), so social handles only count as "strong" when paired with an
// explicit self-share cue ("my insta…", "dm me…"). Email/phone stay strong as
// they are intrinsically rare and high-value.
const STRONG_PATTERNS: string[] = [
  String.raw`\b\d{1,2}\s?[mf]\b`,
  String.raw`\b[mf]\s?\d{1,2}\b`,
  String.raw`\b\d{1,2}\s?(?:yo|y\/o|years?\s?old)\b`,
  String.raw`[\w.+-]+@[\w-]+\.[a-z]{2,}`, // email
  String.raw`\+\d[\d\s().-]{6,}\d`, // international phone
  // Self-shared social/contact only (cue + platform/handle nearby).
  String.raw`\bmy\s+(?:insta|instagram|telegram|discord|tiktok|linkedin|github|twitter|handle|username|e-?mail)\b`,
  String.raw`\b(?:dm|pm|add|reach|follow|message|contact|hmu|hit)\s+me\b`,
  // Race / ethnicity self-framing — rare & high-value, so jump the queue (the
  // bare words "minority"/"indigenous" are too common to be strong on their own).
  String.raw`\bas\s+an?\s+(?:non-?\s*)?(?:asian|black|white|latino|hispanic|arab|jewish|african|european|indian|chinese)\b`,
  String.raw`\bnon-?\s*(?:asian|black|white|latino|hispanic|arab|african|european|indian|chinese)\b`,
  String.raw`\b(?:i['’]?m|i\s?am)\s+(?:an?\s+)?(?:asian|black|white|latino|hispanic|arab|african|european|indian|chinese)\b`,
  String.raw`\bindigenous\s+minorit\w*\b`,
  // First-person HOME / residence statements — a stated home locality is a
  // potential address locator (high-value, relatively rare for a given user),
  // so jump the queue rather than risk being cut by the candidate cap.
  String.raw`\bi\s+(?:live|stay|grew\s?up|was\s?born)\s+(?:in|at|near|around)\b`,
  String.raw`\bmy\s+(?:block|flat|apartment|estate|hometown|neighbourhood|neighborhood)\b`,
];
const STRONG_SIGNAL = new RegExp(STRONG_PATTERNS.join("|"), "i");

const MAX_IDENTIFIER_CANDIDATES = 150;
const IDENTIFIER_ITEM_CHAR_CAP = 300;

// Contact/social categories carry PII, so they get a deterministic ownership
// backstop on top of the prompt: a contact identifier is only persisted when
// its source text shows a first-person / self-share cue. This guards against
// the model misclassifying a third party's, business's, or bot's handle as the
// user's own.
const CONTACT_CATEGORIES = new Set([
  "Email",
  "Phone",
  "Telegram",
  "Discord",
  "Instagram",
  "X/Twitter",
  "TikTok",
  "LinkedIn",
  "GitHub",
  "Website",
]);
const SELF_OWNERSHIP_CUE =
  /\b(?:my|mine|i'?m|i\s?am)\b|\bhere'?s\s+my\b|\b(?:dm|pm|add|reach|follow|message|contact|hmu|hit)\s+me\b|\bhmu\b/i;

// "Name" is high-value PII with a high false-positive rate (people quote other
// people's, celebrities', and characters' names constantly). It gets the same
// deterministic backstop as contacts: only persist a Name when the source text
// shows an explicit FIRST-PERSON self-naming construct, not just any capitalised
// word the model guessed was the user's name. Two cues:
//   1. explicit naming phrases — case-insensitive ("My name is…", "call me…").
//   2. "I'm <Capitalised given name>" — the pronoun may be cased either way, but
//      the name MUST be capitalised so "i'm tired" / "This is Chicago" don't pass.
const NAME_PHRASE_CUE = /\bmy\s+name\b|\bcall\s+me\b|\bi\s+go\s+by\b|\bname['’]s\b|\bgoes\s+by\b/i;
const NAME_GIVEN_CUE = /\b(?:[Ii]'?m|[Ii]\s?am)\s+[A-Z][a-z'’-]+\b/;
function hasNameSelfCue(text: string): boolean {
  return NAME_PHRASE_CUE.test(text) || NAME_GIVEN_CUE.test(text);
}

// Location categories get the same deterministic backstop as contacts: the model
// is good but still latches onto a city sitting inside a brand/company name
// ("Boston Dynamics" -> "Boston") or a place mentioned topically (news, sports,
// travel) that the user never claimed as their own. Two guards run on the source
// text before a location is persisted.
const LOCATION_CATEGORIES = new Set([
  "Country",
  "State/Province",
  "City",
  "Neighborhood",
  "Possible Address",
  "Residence",
  "Previous Residence",
  "Workplace Location",
  "School Location",
  "Frequent Location",
  "Location",
]);

// Guard 1 — a first-person cue tying a place to the user (residence / origin /
// work / study). Without one, a place name is just topical chatter, not a
// disclosed location.
const LOCATION_SELF_CUE =
  /\b(?:i|we)\s+(?:live[sd]?|stay(?:ed|ing)?|resid\w+|grew\s?up|was\s?born|born\s?and\s?raised|come?\s?from|came\s?from|moved|relocat\w+|work\w*|study|studied|hang\w*)\b|\b(?:i'?m|i\s?am|we'?re)\s+(?:from|based|living|staying)\b|\bmy\s+(?:home|house|hometown|flat|apartment|block|estate|neighbou?rhood|'?hood|office|workplace|school|uni|university|college|town|city|country|area)\b|\bback\s+(?:home\s+)?(?:in|at)\b|\bhere\s+in\b|\b(?:i'?m|i\s?am)\s+(?:a\s+)?resident\b|\bresident\s+(?:of|here)\b/i;

// Guard 2 — corporate/brand suffixes that mean a place token is part of an ORG
// name, not a home (e.g. "Boston Dynamics", "Alaska Airlines"). Deliberately
// EXCLUDES University/College/Polytechnic so genuine "School Location"
// disclosures ("Boston University") survive.
const ORG_SUFFIX =
  "dynamics|robotics|inc|incorporated|corp|corporation|ltd|llc|llp|gmbh|plc|holdings|airlines|airways|motors|pharma|studios?|games|technolog(?:y|ies)|systems|solutions|consulting|ventures|capital|partners|labs|software|networks|brewing|brewery|fc";

/** True when `value` sits immediately beside a corporate/brand suffix in `text`. */
function isOrgAdjacentPlace(value: string, text: string): boolean {
  const v = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!v) return false;
  return new RegExp(`\\b${v}\\s+(?:${ORG_SUFFIX})\\b|\\b(?:${ORG_SUFFIX})\\s+${v}\\b`, "i").test(text);
}

export async function extractUserIdentifiers(
  sources: IdentifierSourceInput[],
  currentYear: number,
): Promise<IdentifierEntry[]> {
  // Filter the full corpus down to plausible self-disclosures, prioritising
  // strong age/gender markers, then cap to bound the LLM payload.
  const candidates = sources
    .filter((s) => s.text && DISCLOSURE_SIGNAL.test(s.text))
    .sort((a, b) => Number(STRONG_SIGNAL.test(b.text)) - Number(STRONG_SIGNAL.test(a.text)))
    .slice(0, MAX_IDENTIFIER_CANDIDATES);

  if (candidates.length === 0) return [];

  const fmtPosted = (d?: Date | null): string => {
    if (!d) return "date unknown";
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return "date unknown";
    return dt.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  };

  const numbered = candidates
    .map(
      (s, i) =>
        `[${i}] (${s.sourceType}, posted ${fmtPosted(s.postedAt)}) ${s.text.replace(/\s+/g, " ").trim().slice(0, IDENTIFIER_ITEM_CHAR_CAP)}`,
    )
    .join("\n");

  const prompt = `You are extracting EXPLICITLY self-disclosed personal identifiers from a Reddit user's own posts and comments.

STRICT RULES:
- Only extract attributes the user EXPLICITLY states about THEMSELVES (first person).
- The "quote" MUST be a short verbatim substring copied from the source item.
- Do NOT infer, guess, or deduce. If an attribute is implied but not stated, skip it.
- Ignore statements about other people, hypotheticals, or quotes of others.
- One source phrase can yield multiple identifiers, e.g. "23M" -> Age and Gender.
- Contact & social: extract ONLY the user's OWN handle/address that THEY explicitly share (e.g. "my insta is @x", "dm me at name@mail.com"). NEVER extract other people's, businesses', bots', or support-line contacts, and never a handle merely mentioned in passing.

CATEGORY GUIDE — pick the SINGLE best fit and use the category name EXACTLY as written.

Demographics: "Name", "Age", "Date of Birth", "Gender", "Nationality", "Race/Ethnicity", "Religion".
- "Name" = the user's OWN real name or the name they go by, stated in the first person (e.g. "my name is Jason", "call me Mei", "I'm Daniel btw", "name's Raj"). Put just the name in "value". CRITICAL: do NOT extract names of OTHER people, celebrities, politicians, characters, brands, or a name merely mentioned in conversation — only a name the user explicitly gives as THEIR own.
- "Date of Birth" = an explicit birth date / birth year / birthday the user states (e.g. "I was born in 1998", "my birthday is 3 Jan"). NOT the same as Age — only emit when an actual date/year is given.
- "Religion" = the user's OWN stated faith or lack thereof (e.g. "I'm Christian", "as a Muslim", "I'm an atheist/free-thinker"). First person only; never infer from topical religious discussion.
- "Nationality" = citizenship / national origin (e.g. "I'm American", "I'm British", "I'm Nigerian").
- "Race/Ethnicity" = racial or ethnic group, NOT citizenship (e.g. "Black", "White", "Latino", "Arab", "Han Chinese", "South Asian"). Phrases like "as a Black man", "I'm Latino", or "even I as a non-white person" describe race/ethnicity → use "Race/Ethnicity", never "Nationality". Many ethnonyms (e.g. Chinese, Indian, Kurdish) double as nationalities; classify by the user's clear meaning and default ambiguous ethnic-group usage to "Race/Ethnicity". Self-identifying as "a minority" or "of the indigenous minority" is a Race/Ethnicity disclosure — record the user's own words as the value (e.g. "Indigenous minority"); do NOT infer the specific group name they did not state.
- NEGATIVE / exclusionary self-statements still belong to their NATURAL category — never dump them in "Other". "I'm not American" / "I'm no American" → "Nationality" with value "Not American"; "I'm not white" / "as a non-white person" → "Race/Ethnicity" with value "Not White". Phrase the value as the negation ("Not <X>"); the same rule applies to any other category (e.g. "I don't drive" is NOT an identifier — only keep negations that pin a real attribute like nationality/race/religion).
CRITICAL (Age): only emit "Age" when the user states THEIR OWN CURRENT age in the first person (e.g. "I'm 23", "23M", "turning 30 next month", "I'm in my 40s"). Do NOT emit Age from:
- generic/categorical statements about people of an age — these are about a group, not the speaker (e.g. "a 19.5 year old can work already, unlike most still studying", "most 30yos should…", "kids these days are…").
- someone else's age ("my son is 5", "my wife is 28") — never record another person's age as the user's; if a relative is mentioned, capture them under "Family" instead.
- past or hypothetical ages that don't pin the current age ("when I was 19…", "if I were 18…").

Family (immediate relatives the user mentions about THEMSELVES in first person — capture the relative's EXISTENCE, never their attributes as the user's own): "Family". Value = a concise relation the user HAS, e.g. "Has a son", "Has a daughter", "Has a wife", "Has a husband", "Has children". Trigger on first-person possessives ("my son/daughter/kid(s)/wife/husband/partner"). One identifier per distinct relative type. A spouse mention may ALSO yield "Relationship Status": "Married". Do NOT use "Family" for non-relatives or people merely mentioned.

Other simple ones: "Relationship Status", "Military Service", "Languages" (one identifier per language).

Employment:
- "Occupation" — the user's job/role (e.g. "I'm a nurse", "I work as a software engineer").
- "Employer" — the NAMED company/agency/organisation the user works for (e.g. "I work at Google", "I'm with the city council"). Only a real named employer the user ties to themselves; never a company merely discussed.
- "Employment Status" — employed / self-employed / unemployed / retired / student / between jobs / freelance, when the user states it (e.g. "I'm unemployed now", "I just got retrenched", "I'm self-employed").

Assets & lifestyle (first person only — the user's OWN):
- "Housing" — housing type / ownership (e.g. "I own a condo", "I rent a room", "I have a mortgage", "landed property", "still staying with parents"). Put the concise descriptor in "value" (e.g. "Owns a condo", "Rents", "Owns a house").
- "Vehicle" — owns/rides a vehicle (e.g. "my car", "I ride a motorbike"). Value e.g. "Owns a car", "Rides a motorbike". Include model/plate ONLY if the user explicitly states it.
- "Financial" — a self-stated financial signal (income band, investments, debt, savings, net worth), e.g. "I earn 5k a month", "I'm in debt", "my portfolio". Keep the user's own words concise; do NOT infer wealth from lifestyle.
- "Travel History" — a place the user says they VISITED or travelled to (NOT lived in — that's a Location category), e.g. "I visited Japan last year", "I backpacked Europe". One identifier per distinct place; value = the place.
- "Affiliations" — a club / society / union / CCA / political party / religious org / volunteer group the user says they belong to (e.g. "I'm a member of the teachers' union", "I volunteer at the food bank"). Value = the named group + role if stated.

Education (about the user's OWN schooling):
- "School" — a school name (primary/secondary/JC/high school), e.g. "Lincoln High School".
- "University" — university / polytechnic / college, e.g. "Stanford University", "the state community college".
- "Course of Study" — field / major / programme, e.g. "Computer Science".
- "Graduation Year" — e.g. "2021" or "class of 2019".

Location — TWO axes. Prefer the contextual category when the user says what a place means to them; otherwise use the granular geographic one. Put just the place name in "value".
- Contextual: "Possible Address" (a SPECIFIC place the user says is their HOME at sub-city granularity — estate / neighbourhood / town / street / block / postal area, i.e. a potential home-address locator, e.g. "I live in Brooklyn", "I stay in Camden", "my block in the East End", "I'm from Brooklyn"), "Residence" (lives in a broad city/country, e.g. "I live in Berlin"), "Previous Residence" (used to live there, e.g. "I used to live in Manchester"), "Workplace Location" (e.g. "my office is downtown"), "School Location" (e.g. "I study at Stanford"), "Frequent Location" (often goes there, e.g. "I hang around the old town a lot").
- Granular (role unclear): "Country", "State/Province", "City", "Neighborhood" (district/estate/town). Use generic "Location" only when neither role nor granularity is clear.
- CRITICAL: a place is a location identifier ONLY if the user ties it to THEMSELVES with a first-person cue (e.g. "I live/stay/grew up/was born/am from in X", "I work/study in X", "my hometown/block/estate/office is X"). No such cue → do NOT emit a location.
- Do NOT extract a place that is part of a PROPER NOUN — a company, brand, product, sports team, organisation, building, event, or person's name (e.g. "Boston Dynamics" → NOT Boston; "Manchester United" → NOT Manchester; "Paris Hilton" → NOT Paris; "Alaska Airlines" → NOT Alaska). The city inside such a name is never the user's location.
- Do NOT extract places mentioned topically — news, politics, sports, history, or travel/holiday chat — or a place the user says they are NOT from. Examples that are NOT locations: "boston dynamics better have a product…" (company), "flights to Tokyo were cheap" (travel mention).

Contact & social (verbatim handle/address in "value"): "Email", "Phone", "Telegram", "Discord", "Instagram", "X/Twitter", "TikTok", "LinkedIn", "GitHub", "Website".

Use "Other" (with a descriptive value) only for an explicit self-disclosure that fits nothing above.

Value formatting:
- Age: report the stated age and annotate WHEN it was true, using the "posted" date of the SAME source item the age came from — NOT today. Format: "23 (as of Nov 2025)" using the item's posted month and year. If that item's date is unknown, fall back to "23 (as of ${currentYear})". Do NOT recompute or age the person forward to today.
- Date of Birth: keep the user's stated date/year as given (e.g. "1998", "3 Jan 1998").
- Gender: normalize to "Male", "Female", or the user's stated term.
- Languages: one identifier per language.
- Graduation Year: just the year (e.g. "2021"); keep "class of YYYY" if that is how it was stated.
- Contact & social: copy the handle/address verbatim, keeping a leading "@" if present; for Website keep the URL or domain.
- Keep values concise and human-readable.

Allowed category names (use EXACTLY one of these): ${IDENTIFIER_CATEGORIES.join(", ")}

Source items (index in brackets; each shows when it was posted):
${numbered.slice(0, 12000)}

Return ONLY valid JSON in this exact format:
{
  "identifiers": [
    { "category": "Name", "value": "Jason", "quote": "my name is Jason", "sourceIndex": 9 },
    { "category": "Age", "value": "23 (as of Nov 2025)", "quote": "23M", "sourceIndex": 0 },
    { "category": "Family", "value": "Has a son", "quote": "my son just turned 5", "sourceIndex": 4 },
    { "category": "Employer", "value": "Google", "quote": "I work at Google", "sourceIndex": 5 },
    { "category": "Housing", "value": "Owns a condo", "quote": "just bought my condo", "sourceIndex": 6 },
    { "category": "Religion", "value": "Christian", "quote": "as a Christian myself", "sourceIndex": 7 },
    { "category": "Travel History", "value": "Japan", "quote": "I visited Japan last year", "sourceIndex": 8 },
    { "category": "Possible Address", "value": "Brooklyn", "quote": "I live in Brooklyn", "sourceIndex": 1 },
    { "category": "Instagram", "value": "@janedoe", "quote": "my insta is @janedoe", "sourceIndex": 2 }
  ]
}
If nothing is explicitly self-disclosed, return { "identifiers": [] }.`;

  let parsed: { identifiers?: RawIdentifier[] };
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractCompletionText(response);
    parsed = parseAiJson<{ identifiers?: RawIdentifier[] }>(text);
  } catch (err) {
    logger.error({ err }, "Failed to extract user identifiers");
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Resolve indices -> sources and dedupe by (category, value), merging sources.
  const byKey = new Map<string, IdentifierEntry>();
  for (const raw of parsed.identifiers ?? []) {
    const category = scrubForJsonb((raw.category ?? "").trim());
    const value = scrubForJsonb((raw.value ?? "").trim());
    const quote = scrubForJsonb((raw.quote ?? "").trim());
    if (!category || !value) continue;
    const source = typeof raw.sourceIndex === "number" ? candidates[raw.sourceIndex] : undefined;
    if (!source) continue;

    // PII backstop: only persist a contact/social handle if the source text
    // actually shows first-person ownership; otherwise drop it (the model may
    // have surfaced someone else's, a business's, or a bot's handle).
    if (CONTACT_CATEGORIES.has(category) && !SELF_OWNERSHIP_CUE.test(source.text)) continue;

    // Name backstop: only persist a Name when the source text has an explicit
    // first-person self-naming construct ("my name is…", "call me…"); drops a
    // name the model lifted from someone else, a celebrity, or a character.
    if (category === "Name" && !hasNameSelfCue(source.text)) continue;

    // Location backstop: only persist a place the user actually ties to
    // themselves (guard 1), and never one that is part of a brand/company name
    // such as "Boston Dynamics" (guard 2). Catches model slips the prompt misses.
    if (LOCATION_CATEGORIES.has(category)) {
      if (!LOCATION_SELF_CUE.test(source.text)) continue;
      if (isOrgAdjacentPlace(value, source.text)) continue;
    }

    const key = `${category.toLowerCase()}::${value.toLowerCase()}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { category, value, sources: [] };
      byKey.set(key, entry);
    }
    const permalink = source.permalink ?? null;
    let postedAt: string | null = null;
    if (source.postedAt) {
      const d = source.postedAt instanceof Date ? source.postedAt : new Date(source.postedAt);
      postedAt = Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const dupe = entry.sources.some((s) => s.permalink === permalink && s.quote === quote);
    if (!dupe) {
      entry.sources.push({ quote, permalink, sourceType: source.sourceType, postedAt });
    }
  }

  return Array.from(byKey.values());
}

/**
 * Merge a freshly extracted identifier set into the ones already on file so a
 * (re)analysis can only ADD identifiers, never silently erase them. Entries are
 * unioned by (category, value) — case-insensitive — and every supporting source
 * (quote + permalink) is preserved, deduplicated by permalink+quote. Existing
 * entries keep their original casing/order; genuinely new ones are appended.
 *
 * This makes identifiers persistent across runs: an incremental crawl over only
 * newer content, or an extraction that returns fewer/zero results, can no longer
 * drop disclosures captured by an earlier run.
 */
export function mergeIdentifierEntries(
  existing: IdentifierEntry[],
  incoming: IdentifierEntry[],
): IdentifierEntry[] {
  const byKey = new Map<string, IdentifierEntry>();
  const order: string[] = [];
  const add = (entry: IdentifierEntry) => {
    const key = `${entry.category.trim().toLowerCase()}::${entry.value.trim().toLowerCase()}`;
    let target = byKey.get(key);
    if (!target) {
      target = { category: entry.category, value: entry.value, sources: [] };
      byKey.set(key, target);
      order.push(key);
    }
    for (const s of entry.sources) {
      const dupe = target.sources.some((e) => e.permalink === s.permalink && e.quote === s.quote);
      if (!dupe) target.sources.push(s);
    }
  };
  for (const e of existing) add(e);
  for (const e of incoming) add(e);
  return order.map((k) => byKey.get(k)!);
}

export interface TopicCommentInput {
  author: string;
  body: string;
  permalink: string;
  score: number;
}

export interface TopicThemeResult {
  name: string;
  commentCount: number;
  percentage: number;
  summary: string[];
  representativeComments: Array<{ author: string; excerpt: string; permalink: string }>;
  comments: Array<{ author: string; excerpt: string; permalink: string }>;
}

export interface TopicFlaggedResult {
  issue: string;
  excerpt: string;
  author: string;
  permalink: string;
}

export interface TopicAnalysisAIResult {
  executiveSummary: string;
  themes: TopicThemeResult[];
  flagged: TopicFlaggedResult[];
  otherComments: Array<{ author: string; excerpt: string; permalink: string }>;
}

export interface TopicAnalysisOptions {
  /** Themes the analyst wants the model to look for and prioritise. */
  themeHints?: string[];
  /** Desired number of themes (clamped to 2-8). Omit for automatic (3-5). */
  themeCount?: number | null;
}

// Tuning for full-pool topic classification. Phase 1 samples the top-voted
// comments to FIX a theme taxonomy; phase 2 then classifies the ENTIRE pool
// against that taxonomy in score-ordered batches, so no comment is dropped and
// every comment that fits a theme is placed in it (the old top-N cap meant most
// comments were never seen by the model and landed in "other" by default).
const TOPIC_SAMPLE_SIZE = 200; // comments used to discover the theme taxonomy
const TOPIC_COMMENT_CHAR_CAP = 600; // per-comment body chars sent to the model
const TOPIC_BATCH_CHAR_BUDGET = 120_000; // ~max comment-text chars per classify call
// Hard cap on comments per classify call. The char budget alone bounds INPUT
// size, but the OUTPUT (one {index,theme} object per comment, plus flagged) grows
// with comment COUNT — and gpt-5.2 is a reasoning model whose reasoning tokens
// also count against max_completion_tokens. A batch packed with many short
// comments could emit an assignments array that overflows the 16384 cap and gets
// truncated mid-JSON ("response cut off"). Capping the count keeps each call's
// output well under the cap regardless of how short the comments are.
const TOPIC_BATCH_MAX_COMMENTS = 150;

/** A discovered theme (name + bullet summary) used as the fixed taxonomy. */
interface TopicThemeDef {
  name: string;
  summary: string[];
}

/** A contiguous slice of the ranked pool plus its global start offset. */
interface CommentBatch {
  startIndex: number;
  comments: TopicCommentInput[];
}

interface RawThemeDef {
  name?: string;
  summary?: string[];
}
interface RawDiscoverResult {
  executiveSummary?: string;
  themes?: RawThemeDef[];
}
interface RawClassifyResult {
  assignments?: Array<{ index?: number; theme?: number }>;
  flagged?: Array<{ index?: number; issue?: string }>;
}

/** Trim a gathered comment down to the {author, excerpt, permalink} report shape. */
function toExcerpt(c: TopicCommentInput): { author: string; excerpt: string; permalink: string } {
  const body = c.body ?? "";
  return {
    author: scrubForJsonb(c.author),
    excerpt: scrubForJsonb(body.length > 240 ? `${body.slice(0, 240).trimEnd()}…` : body),
    permalink: scrubForJsonb(c.permalink),
  };
}

/**
 * Strip characters PostgreSQL `jsonb` rejects: NUL (\u0000) and unpaired UTF-16
 * surrogates. A naive `body.slice(0, n)` can cut an emoji in half and leave a
 * lone surrogate, which `JSON.stringify` emits as `\udXXX`; persisting it fails
 * the ENTIRE report write ("invalid input syntax for type json"), so every
 * stored string is scrubbed.
 */
function scrubForJsonb(s: string): string {
  return s
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Split the ranked pool into contiguous batches bounded by a character budget,
 * each carrying its global start offset so per-batch indices map back to the
 * full pool. Keeps each classify call within the model's context window.
 */
function batchByChars(
  ranked: TopicCommentInput[],
  charBudget: number,
  perCommentCap: number,
  maxCount: number,
): CommentBatch[] {
  const batches: CommentBatch[] = [];
  let current: TopicCommentInput[] = [];
  let start = 0;
  let used = 0;
  for (let i = 0; i < ranked.length; i++) {
    const cost = Math.min(ranked[i].body?.length ?? 0, perCommentCap) + 40;
    if (current.length > 0 && (used + cost > charBudget || current.length >= maxCount)) {
      batches.push({ startIndex: start, comments: current });
      current = [];
      start = i;
      used = 0;
    }
    current.push(ranked[i]);
    used += cost;
  }
  if (current.length > 0) batches.push({ startIndex: start, comments: current });
  return batches;
}

/**
 * Phase 1 — establish a fixed theme taxonomy and the executive summary from a
 * high-signal (top-voted) sample. The full pool is classified against this list
 * in phase 2, so the themes stay consistent regardless of how many batches the
 * full pool is split into.
 */
async function discoverTopicThemes(
  topicSummary: string,
  sample: TopicCommentInput[],
  themeCountClause: string,
  steeringBlock: string,
): Promise<{ themeDefs: TopicThemeDef[]; executiveSummary: string }> {
  const commentBlock = sample
    .map(
      (c, i) =>
        `#${i} by ${c.author} (score ${c.score})\n${c.body.slice(0, TOPIC_COMMENT_CHAR_CAP)}`,
    )
    .join("\n\n");

  const prompt = `You are an analyst summarizing public online discussion about a specific topic.

TOPIC UNDER INVESTIGATION (provided by the analyst):
${topicSummary}
${steeringBlock}
IMPORTANT ETHICS RULES:
- Analyze only expressed opinions, sentiment, and discussion themes.
- Do NOT infer or speculate about: race, ethnicity, religion, nationality, occupation, income, medical conditions, mental health, or other protected characteristics.
- Do NOT identify or deanonymize individuals. Use only the usernames as given.
- This is a probabilistic summary of public comments, not a factual judgement about any person.

Below is a representative sample of ${sample.length} of the most relevant comments.

COMMENTS:
${commentBlock}

Your task:
1. Decide on ${themeCountClause} distinct sentiment/discussion themes that best organise the discussion. These themes will be used to classify a MUCH larger set of comments, so make them clear, distinct, and collectively cover the discussion.
2. Write a 2-4 sentence overall executive summary of the discussion.

Return ONLY valid JSON in this exact shape:
{
  "executiveSummary": "",
  "themes": [
    { "name": "", "summary": ["", ""] }
  ]
}

Rules:
- Produce ${themeCountClause} themes.
- name is a short, descriptive theme label.
- summary is 2-5 short bullet strings describing what comments in this theme say.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });
  const parsed = parseAiJson<RawDiscoverResult>(extractCompletionText(response));
  const themeDefs: TopicThemeDef[] = (Array.isArray(parsed.themes) ? parsed.themes : [])
    .map((t) => ({
      name: typeof t.name === "string" ? scrubForJsonb(t.name.trim()) : "",
      summary: Array.isArray(t.summary)
        ? t.summary.filter((s) => typeof s === "string").map((s) => scrubForJsonb(s))
        : [],
    }))
    .filter((t) => t.name.length > 0);
  return {
    themeDefs,
    executiveSummary:
      typeof parsed.executiveSummary === "string" ? scrubForJsonb(parsed.executiveSummary) : "",
  };
}

/**
 * Phase 2 — classify one batch of comments into the FIXED theme list (by id) and
 * flag concerning ones. Returns [globalIndex, themeIndex] pairs (themeIndex -1 =
 * "other") plus flagged comments resolved back to full objects. The model only
 * emits index→theme numbers (never transcribes bodies), which it does reliably.
 */
async function classifyTopicBatch(
  topicSummary: string,
  themeNames: string[],
  batch: CommentBatch,
): Promise<{ assignments: Array<[number, number]>; flagged: TopicFlaggedResult[] }> {
  const themeList = themeNames.map((n, i) => `${i}: ${n}`).join("\n");
  const commentBlock = batch.comments
    .map(
      (c, i) =>
        `#${batch.startIndex + i} by ${c.author} (score ${c.score})\n${c.body.slice(0, TOPIC_COMMENT_CHAR_CAP)}`,
    )
    .join("\n\n");

  const prompt = `You are an analyst classifying public online comments about a topic into a FIXED set of themes.

TOPIC UNDER INVESTIGATION:
${topicSummary}

IMPORTANT ETHICS RULES:
- Classify only by expressed opinion, sentiment, and discussion theme.
- Do NOT infer protected characteristics or deanonymize anyone.

THEMES (use these exact id numbers):
${themeList}

Each comment below begins with an index (#N), the author, and score.

COMMENTS:
${commentBlock}

Your task:
1. Assign EVERY comment to the single best-fitting theme id above. Only if a comment genuinely fits none of the themes, assign it theme -1 ("other"). Prefer a real theme whenever there is any reasonable fit.
2. Flag any comments that require attention (harassment, threats, severe toxicity, misinformation, calls to action, or clear distress). If none, return an empty list.

Return ONLY valid JSON in this exact shape:
{
  "assignments": [ { "index": 0, "theme": 0 } ],
  "flagged": [ { "index": 0, "issue": "" } ]
}

Rules:
- Provide exactly ONE assignment object for EVERY comment index shown above.
- index is the #N number; theme is the theme id number (or -1 for other).
- Do NOT transcribe comment bodies — only their index and theme numbers.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 16384,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });
  const parsed = parseAiJson<RawClassifyResult>(extractCompletionText(response));

  const assignments: Array<[number, number]> = [];
  for (const a of Array.isArray(parsed.assignments) ? parsed.assignments : []) {
    const idx = typeof a.index === "number" ? a.index : Number(a.index);
    const theme = typeof a.theme === "number" ? a.theme : Number(a.theme);
    if (Number.isInteger(idx)) assignments.push([idx, Number.isInteger(theme) ? theme : -1]);
  }

  const flagged: TopicFlaggedResult[] = [];
  for (const f of Array.isArray(parsed.flagged) ? parsed.flagged : []) {
    const idx = typeof f.index === "number" ? f.index : Number(f.index);
    const local = idx - batch.startIndex;
    if (!Number.isInteger(local) || local < 0 || local >= batch.comments.length) continue;
    const c = batch.comments[local];
    const e = toExcerpt(c);
    flagged.push({
      issue: typeof f.issue === "string" ? scrubForJsonb(f.issue) : "",
      excerpt: e.excerpt,
      author: e.author,
      permalink: e.permalink,
    });
  }
  return { assignments, flagged };
}

/** Split a batch into two contiguous halves, preserving global start offsets. */
function splitBatch(batch: CommentBatch): [CommentBatch, CommentBatch] {
  const mid = Math.floor(batch.comments.length / 2);
  return [
    { startIndex: batch.startIndex, comments: batch.comments.slice(0, mid) },
    { startIndex: batch.startIndex + mid, comments: batch.comments.slice(mid) },
  ];
}

/**
 * Classify a batch, but if the model's JSON gets cut off by the token cap, split
 * the batch in half and classify each half, then recombine — recursively. This
 * guarantees EVERY comment is classified no matter the volume: an oversized batch
 * self-heals instead of failing the whole run. Only a TokenLimitError triggers a
 * split (other errors propagate); a single comment that still overflows is
 * effectively impossible under the 16384 cap and is re-thrown.
 */
async function classifyTopicBatchAdaptive(
  topicSummary: string,
  themeNames: string[],
  batch: CommentBatch,
): Promise<{ assignments: Array<[number, number]>; flagged: TopicFlaggedResult[] }> {
  try {
    return await classifyTopicBatch(topicSummary, themeNames, batch);
  } catch (err) {
    if (err instanceof TokenLimitError && batch.comments.length > 1) {
      logger.warn(
        { size: batch.comments.length },
        "Classify batch hit the token limit; splitting in half and retrying",
      );
      const [left, right] = splitBatch(batch);
      const [lr, rr] = await Promise.all([
        classifyTopicBatchAdaptive(topicSummary, themeNames, left),
        classifyTopicBatchAdaptive(topicSummary, themeNames, right),
      ]);
      return {
        assignments: [...lr.assignments, ...rr.assignments],
        flagged: [...lr.flagged, ...rr.flagged],
      };
    }
    throw err;
  }
}

/**
 * Flag concerning comments from a SINGLE user's history (no theme grouping).
 *
 * Mirrors the Topic Analysis flag pass, but returns ONLY the flags, each keyed
 * by the comment's global index in the input array so the caller can map it back
 * to a DB comment row. The model emits index→issue pairs (never transcribes
 * bodies), which it does reliably. One batch per char budget; an oversized batch
 * that hits the token cap self-heals by splitting in half (TokenLimitError).
 */
async function flagCommentBatch(batch: CommentBatch): Promise<Array<{ index: number; issue: string }>> {
  const commentBlock = batch.comments
    .map(
      (c, i) =>
        `#${batch.startIndex + i} by ${c.author} (score ${c.score})\n${c.body.slice(0, TOPIC_COMMENT_CHAR_CAP)}`,
    )
    .join("\n\n");

  const prompt = `You are a content-safety analyst reviewing one Reddit user's public comments to surface those that warrant analyst attention.

IMPORTANT ETHICS RULES:
- Judge only the expressed content. Do NOT infer protected characteristics or deanonymize anyone.

Each comment below begins with an index (#N), the author, and score.

COMMENTS:
${commentBlock}

Your task:
Flag any comments that require attention (harassment, threats, severe toxicity, misinformation, calls to action, or clear distress). If none, return an empty list.

Return ONLY valid JSON in this exact shape:
{
  "flagged": [ { "index": 0, "issue": "" } ]
}

Rules:
- index is the #N number; issue is a SHORT reason (e.g. "Harassment", "Threat of violence", "Misinformation").
- Only flag comments that genuinely warrant attention; do NOT flag ordinary opinions, disagreement, or mild profanity on its own.
- Do NOT transcribe comment bodies — only their index and a short issue.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 16384,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });
  const parsed = parseAiJson<RawClassifyResult>(extractCompletionText(response));

  const flagged: Array<{ index: number; issue: string }> = [];
  for (const f of Array.isArray(parsed.flagged) ? parsed.flagged : []) {
    const idx = typeof f.index === "number" ? f.index : Number(f.index);
    const local = idx - batch.startIndex;
    if (!Number.isInteger(local) || local < 0 || local >= batch.comments.length) continue;
    flagged.push({ index: idx, issue: typeof f.issue === "string" ? scrubForJsonb(f.issue) : "" });
  }
  return flagged;
}

/** flagCommentBatch with the same adaptive token-limit self-healing as classify. */
async function flagCommentBatchAdaptive(batch: CommentBatch): Promise<Array<{ index: number; issue: string }>> {
  try {
    return await flagCommentBatch(batch);
  } catch (err) {
    if (err instanceof TokenLimitError && batch.comments.length > 1) {
      logger.warn({ size: batch.comments.length }, "Flag batch hit the token limit; splitting in half and retrying");
      const [left, right] = splitBatch(batch);
      const [lr, rr] = await Promise.all([flagCommentBatchAdaptive(left), flagCommentBatchAdaptive(right)]);
      return [...lr, ...rr];
    }
    throw err;
  }
}

/**
 * Flag concerning comments across a user's comment corpus. Returns the GLOBAL
 * index (into `comments`) of each flagged comment plus a short issue. Batches run
 * concurrently. Re-throws on failure so the caller can decide whether to treat a
 * flag-pass failure as fatal (it does not — flagging is supplementary).
 */
export async function flagConcerningComments(
  comments: TopicCommentInput[],
): Promise<Array<{ index: number; issue: string }>> {
  if (comments.length === 0) return [];
  const batches = batchByChars(comments, TOPIC_BATCH_CHAR_BUDGET, TOPIC_COMMENT_CHAR_CAP, TOPIC_BATCH_MAX_COMMENTS);
  const results = await Promise.all(batches.map((b) => flagCommentBatchAdaptive(b)));
  // First flag for a given index wins; ignore out-of-range/duplicate indices.
  const seen = new Set<number>();
  const flagged: Array<{ index: number; issue: string }> = [];
  for (const batchFlags of results) {
    for (const f of batchFlags) {
      if (f.index < 0 || f.index >= comments.length || seen.has(f.index)) continue;
      seen.add(f.index);
      flagged.push(f);
    }
  }
  return flagged;
}

/**
 * Group a pool of comments (gathered for a user-described topic) into
 * sentiment/discussion themes and flag comments needing attention.
 *
 * EVERY comment is classified: phase 1 fixes a theme taxonomy from a top-voted
 * sample, phase 2 classifies the whole pool against it in score-ordered batches.
 * The theme/other partition is keyed on each comment's unique position in the
 * ranked pool (NOT permalink — many comments share a permalink). Re-throws on
 * failure so the caller can mark the run failed rather than persist a junk report.
 */
export async function analyzeTopicComments(
  topicSummary: string,
  comments: TopicCommentInput[],
  options: TopicAnalysisOptions = {},
): Promise<TopicAnalysisAIResult> {
  if (comments.length === 0) {
    throw new Error("No comments were gathered for this topic, so there is nothing to analyze.");
  }

  // Sanitise analyst steering hints. Empty/whitespace entries are dropped, and
  // the desired theme count is clamped to a sane range. When neither is given
  // the model falls back to fully automatic grouping (3-5 themes).
  const themeHints = (options.themeHints ?? [])
    .map((h) => h.trim())
    .filter(Boolean);
  const themeCount =
    options.themeCount != null && Number.isFinite(options.themeCount)
      ? Math.min(8, Math.max(2, Math.round(options.themeCount)))
      : null;

  // Order the ENTIRE pool by score (highest-signal first). We no longer cap the
  // pool — every comment is classified in phase 2 below. A comment's position in
  // `ranked` is its stable index, used both for batching and for the final
  // theme/other partition (so the partition never relies on the non-unique
  // permalink). `ranked` being score-descending also makes the first comments in
  // any theme its top-voted, which we use to pick representative comments.
  const ranked = [...comments].sort((a, b) => b.score - a.score);
  const total = ranked.length;

  // Compose the analyst's optional steering preferences into the task line and a
  // dedicated guidance block. When neither hint nor count is provided the prompt
  // is identical to the original fully-automatic behaviour.
  const themeCountClause = themeCount != null ? `exactly ${themeCount}` : "3 to 5";
  const steeringLines: string[] = [];
  if (themeHints.length > 0) {
    steeringLines.push(
      `- The analyst is especially interested in these themes: ${themeHints
        .map((h) => `"${h}"`)
        .join(", ")}. Prioritise grouping comments around these where the discussion supports them. Use the analyst's wording for those theme names. You may add other themes for substantial topics not covered by these hints, and you may omit a hinted theme only if no comments relate to it.`,
    );
  }
  if (themeCount != null) {
    steeringLines.push(
      `- The analyst wants exactly ${themeCount} themes. Produce ${themeCount} themes (merge or split discussion as needed to hit this number).`,
    );
  }
  const steeringBlock =
    steeringLines.length > 0
      ? `\nANALYST GROUPING PREFERENCES:\n${steeringLines.join("\n")}\n`
      : "";

  try {
    // ---- Phase 1: discover the theme taxonomy + executive summary -------------
    // A high-signal (top-voted) sample is enough to establish the themes and the
    // overall summary; the full pool is classified against them in phase 2.
    const sample = ranked.slice(0, Math.min(TOPIC_SAMPLE_SIZE, total));
    const { themeDefs, executiveSummary } = await discoverTopicThemes(
      topicSummary,
      sample,
      themeCountClause,
      steeringBlock,
    );

    // No usable themes -> everything is "other" (deterministic empty partition).
    if (themeDefs.length === 0) {
      return {
        executiveSummary,
        themes: [],
        flagged: [],
        otherComments: ranked.map(toExcerpt),
      };
    }

    // ---- Phase 2: classify EVERY comment into the fixed themes, in batches ----
    // Batches are independent (same fixed taxonomy) so they run concurrently.
    const batches = batchByChars(
      ranked,
      TOPIC_BATCH_CHAR_BUDGET,
      TOPIC_COMMENT_CHAR_CAP,
      TOPIC_BATCH_MAX_COMMENTS,
    );
    const themeNames = themeDefs.map((t) => t.name);
    const batchResults = await Promise.all(
      batches.map((b) => classifyTopicBatchAdaptive(topicSummary, themeNames, b)),
    );

    // assignment[globalIndex] = theme index, or -1 for "other"/unassigned. The
    // first valid assignment for an index wins; later duplicates are ignored.
    const assignment = new Array<number>(total).fill(-1);
    const flagged: TopicFlaggedResult[] = [];
    for (const r of batchResults) {
      for (const [globalIdx, themeIdx] of r.assignments) {
        if (
          Number.isInteger(globalIdx) &&
          globalIdx >= 0 &&
          globalIdx < total &&
          themeIdx >= 0 &&
          themeIdx < themeNames.length &&
          assignment[globalIdx] === -1
        ) {
          assignment[globalIdx] = themeIdx;
        }
      }
      for (const f of r.flagged) flagged.push(f);
    }

    // ---- Phase 3: assemble themes, representatives, and the "other" pool ------
    // The partition is keyed on the comment's unique position in `ranked` (NOT
    // permalink), so themed + other always reconcile to the full pool even when
    // many comments share a permalink (e.g. all replies under one video).
    const themes: TopicThemeResult[] = themeDefs.map((def, themeIdx) => {
      const themeComments: Array<{ author: string; excerpt: string; permalink: string }> = [];
      for (let i = 0; i < total; i++) {
        if (assignment[i] === themeIdx) themeComments.push(toExcerpt(ranked[i]));
      }
      return {
        name: def.name,
        commentCount: themeComments.length,
        percentage: total > 0 ? Math.round((themeComments.length / total) * 100) : 0,
        summary: def.summary,
        // `ranked` is score-descending, so the first few are the top-voted.
        representativeComments: themeComments.slice(0, 3),
        comments: themeComments,
      };
    });

    const otherComments = ranked.filter((_, i) => assignment[i] === -1).map(toExcerpt);

    return { executiveSummary, themes, flagged, otherComments };
  } catch (err) {
    logger.error({ err }, "Failed to analyze topic comments");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function buildEmptyResult(): AnalysisResult {
  const archetypes: Record<string, ArchetypeResult> = {};
  for (const a of ARCHETYPES) {
    archetypes[a.key] = { score: 0, confidence: 0, evidence: [] };
  }
  return {
    archetypes,
    dominant_archetypes: ["mixed_unclassified"],
    summary: "Insufficient content to perform analysis.",
    recurring_themes: [],
    theme_labels: [],
    confidence_notes: "Not enough data for reliable classification.",
  };
}
