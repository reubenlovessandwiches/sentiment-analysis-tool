import { forwardRef } from "react";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
} from "recharts";

/* ── Formal light-theme palette (independent of the app's dark UI) ── */
const INK = "#111111";
const MUTED = "#555555";
const ACCENT = "#0d7a5f";
const DANGER = "#b42318";
const BORDER = "#d0d0d0";
const FONT = "Helvetica, Arial, sans-serif";

const page: React.CSSProperties = {
  width: "100%",
  maxWidth: 760,
  background: "#ffffff",
  color: INK,
  fontFamily: FONT,
  fontSize: 13,
  lineHeight: 1.55,
  padding: 4,
  boxSizing: "border-box",
};

const section: React.CSSProperties = {
  marginBottom: 18,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: MUTED,
  fontWeight: 700,
  marginBottom: 8,
};

export interface ProfilePdfStat {
  label: string;
  value: string;
}

export interface ProfilePdfArchetype {
  archetypeKey: string;
  archetypeName: string;
  score: number;
  confidence: number;
}

export interface ProfilePdfTrendPoint {
  date: string;
  score: number;
}

export interface ProfilePdfContentItem {
  id: string | number;
  text: string;
  url?: string | null;
  meta?: string | null;
  date?: string | null;
}

/** A single evidence source backing a self-disclosed identifier. */
export interface ProfilePdfIdentifierSource {
  quote: string;
  permalink?: string | null;
  sourceType: string;
  postedAt?: string | null;
}

/** A self-disclosed identifier (Reddit-only) with its supporting sources. */
export interface ProfilePdfIdentifier {
  category: string;
  value: string;
  sources: ProfilePdfIdentifierSource[];
}

export interface ProfilePdfData {
  title: string;
  subtitle?: string | null;
  stats: ProfilePdfStat[];
  archetypeScores: ProfilePdfArchetype[];
  summary?: string | null;
  recurringThemes?: string[];
  confidenceNotes?: string | null;
  trends?: ProfilePdfTrendPoint[] | null;
  postsLabel?: string;
  posts?: ProfilePdfContentItem[];
  commentsLabel?: string;
  comments?: ProfilePdfContentItem[];
  /** Self-disclosed identifiers (Reddit-only); drives the Identity Dossier section. */
  identifiers?: ProfilePdfIdentifier[];
  /** AI-flagged concerning comments (Reddit-only); drives the "Comments Requiring Attention" section. */
  flagged?: ProfilePdfFlagged[];
}

/** An AI-flagged "comment requiring attention" (Reddit-only). */
export interface ProfilePdfFlagged {
  issue: string;
  excerpt: string;
  permalink?: string | null;
  meta?: string | null;
}

function fmtSourceDate(iso?: string | null): string {
  if (!iso) return "Date unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Date unknown";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function Stat({ stat }: { stat: ProfilePdfStat }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 800, color: ACCENT }}>{stat.value}</div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: MUTED,
        }}
      >
        {stat.label}
      </div>
    </div>
  );
}

/**
 * One self-disclosed identifier: its category + value, followed by every
 * supporting source (verbatim quote + the FULLY printed permalink that led to
 * the attribution).
 */
function IdentifierBlock({ entry }: { entry: ProfilePdfIdentifier }) {
  return (
    <div data-pdf-section style={{ padding: "10px 0", borderBottom: `1px solid ${BORDER}` }}>
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: MUTED,
          fontWeight: 700,
        }}
      >
        {entry.category}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, margin: "1px 0 6px" }}>{entry.value}</div>
      {entry.sources.length === 0 ? (
        <div style={{ fontSize: 10.5, color: MUTED, fontStyle: "italic" }}>No source recorded.</div>
      ) : (
        entry.sources.map((s, j) => (
          <div
            key={j}
            style={{
              margin: "0 0 8px",
              paddingLeft: 10,
              borderLeft: `2px solid ${BORDER}`,
            }}
          >
            <div style={{ fontSize: 12, fontStyle: "italic", color: "#333333" }}>“{s.quote}”</div>
            <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>
              {s.sourceType} · {fmtSourceDate(s.postedAt)}
            </div>
            {s.permalink ? (
              <div
                style={{
                  marginTop: 2,
                  fontSize: 10.5,
                  color: ACCENT,
                  wordBreak: "break-all",
                }}
              >
                {s.permalink}
              </div>
            ) : (
              <div style={{ marginTop: 2, fontSize: 10, color: MUTED, fontStyle: "italic" }}>
                No source link available
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/**
 * One AI-flagged "comment requiring attention": its issue/reason, the verbatim
 * excerpt, and the fully-printed source link. Red accent to set it apart from
 * the neutral Identity Dossier blocks.
 */
function FlaggedBlock({ entry }: { entry: ProfilePdfFlagged }) {
  return (
    <div
      data-pdf-section
      style={{
        padding: "10px 12px",
        marginBottom: 8,
        border: `1px solid ${DANGER}`,
        borderLeft: `3px solid ${DANGER}`,
        borderRadius: 3,
        background: "#fdf3f2",
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: DANGER,
          fontWeight: 700,
          marginBottom: 4,
        }}
      >
        {entry.issue}
      </div>
      <div style={{ fontSize: 12.5, fontStyle: "italic", color: "#333333" }}>“{entry.excerpt}”</div>
      {entry.meta && <div style={{ fontSize: 10, color: MUTED, marginTop: 3 }}>{entry.meta}</div>}
      {entry.permalink && (
        <div style={{ marginTop: 2, fontSize: 10.5, color: ACCENT, wordBreak: "break-all" }}>{entry.permalink}</div>
      )}
    </div>
  );
}

/**
 * Light-themed, formal rendering of a user-profile dossier, captured off-screen
 * into a PDF (see DossierPrintButton). Mirrors the topic report's PDF document
 * style (report-pdf-document.tsx).
 *
 * Focused content set: identity + tracked volume, the archetype "web" (radar)
 * chart, the intelligence summary, recurring themes, and (Reddit only) the
 * Identity Dossier — each self-disclosed identifier with the verbatim quotes
 * and fully-printed source links that led to it.
 *
 * The radar uses fixed pixel dimensions (NOT ResponsiveContainer) and disabled
 * animation so it renders deterministically while mounted off-screen and is
 * captured cleanly by html2canvas.
 */
export const ProfilePdfDocument = forwardRef<HTMLDivElement, { data: ProfilePdfData }>(
  function ProfilePdfDocument({ data }, ref) {
    const radarData = data.archetypeScores.map((s) => ({
      subject: s.archetypeName,
      score: s.score,
      fullMark: 100,
    }));
    const identifiers = data.identifiers ?? [];
    const flagged = data.flagged ?? [];

    return (
      <div ref={ref} style={page}>
        {/* Title + identity + tracked volume */}
        <div style={section} data-pdf-section>
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: ACCENT,
              fontWeight: 700,
            }}
          >
            Target Profiled
          </div>
          <h1 style={{ margin: "2px 0 0", fontSize: 24, fontWeight: 800 }}>{data.title}</h1>
          <div style={{ height: 3, width: 70, background: ACCENT, margin: "8px 0 10px" }} />
          {data.subtitle && (
            <p style={{ margin: "0 0 10px", fontSize: 12.5, color: MUTED }}>{data.subtitle}</p>
          )}
          {data.stats.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 24,
                borderTop: `1px solid ${BORDER}`,
                borderBottom: `1px solid ${BORDER}`,
                padding: "10px 0",
              }}
            >
              {data.stats.map((s, i) => (
                <Stat key={i} stat={s} />
              ))}
            </div>
          )}
        </div>

        {/* Archetype signature: radar (web) chart only */}
        {data.archetypeScores.length > 0 && (
          <div style={section} data-pdf-section>
            <div style={sectionLabel}>Archetype Signature</div>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <RadarChart width={700} height={440} data={radarData}>
                <PolarGrid stroke={BORDER} />
                <PolarAngleAxis dataKey="subject" tick={{ fill: MUTED, fontSize: 10 }} />
                <PolarRadiusAxis
                  angle={30}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fill: MUTED, fontSize: 9 }}
                />
                <Radar
                  dataKey="score"
                  stroke={ACCENT}
                  fill={ACCENT}
                  fillOpacity={0.3}
                  isAnimationActive={false}
                />
              </RadarChart>
            </div>
          </div>
        )}

        {/* Intelligence summary + recurring themes */}
        <div style={section} data-pdf-section>
          <div style={sectionLabel}>Intelligence Summary</div>
          <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-line" }}>
            {data.summary || "No summary available."}
          </p>
          {data.recurringThemes && data.recurringThemes.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={sectionLabel}>Recurring Themes</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {data.recurringThemes.map((t, i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: 11,
                      background: "#f3f4f6",
                      border: `1px solid ${BORDER}`,
                      borderRadius: 3,
                      padding: "2px 8px",
                      color: "#333333",
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {data.confidenceNotes && (
            <div style={{ marginTop: 10 }}>
              <div style={sectionLabel}>Confidence Notes</div>
              <p style={{ margin: 0, fontSize: 12.5, color: MUTED }}>{data.confidenceNotes}</p>
            </div>
          )}
        </div>

        {/* Identity Dossier: each self-disclosed identifier is its OWN
            [data-pdf-section] so html2canvas captures small blocks (fast, clean
            page breaks) instead of one oversized canvas. */}
        {identifiers.length > 0 && (
          <>
            <div style={{ ...section, marginBottom: 8 }} data-pdf-section>
              <div style={sectionLabel}>Identity Dossier ({identifiers.length})</div>
              <p style={{ margin: 0, fontSize: 11, color: MUTED }}>
                Self-disclosed attributes extracted from the target's own posts and comments. Each
                value is traceable to the verbatim quote and source link that led to it.
              </p>
            </div>
            {identifiers.map((entry, i) => (
              <IdentifierBlock key={i} entry={entry} />
            ))}
          </>
        )}

        {/* Comments Requiring Attention: AI-flagged concerning comments, each its
            OWN [data-pdf-section] for clean page breaks (matches Identity Dossier). */}
        {flagged.length > 0 && (
          <>
            <div style={{ ...section, marginBottom: 8 }} data-pdf-section>
              <div style={{ ...sectionLabel, color: DANGER }}>
                Comments Requiring Attention ({flagged.length})
              </div>
              <p style={{ margin: 0, fontSize: 11, color: MUTED }}>
                Comments the AI flagged for analyst attention. Each shows the issue, the verbatim
                excerpt, and the source link. These are probabilistic flags, not severity rankings.
              </p>
            </div>
            {flagged.map((entry, i) => (
              <FlaggedBlock key={i} entry={entry} />
            ))}
          </>
        )}

        {/* Disclaimer */}
        <div style={section} data-pdf-section>
          <p style={{ margin: 0, fontSize: 10.5, color: MUTED, textAlign: "center" }}>
            Classifications are probabilistic estimates based on observed discussion patterns.
            Confidence scores indicate reliability. Users may fit multiple archetypes. This analysis
            does not infer protected characteristics.
          </p>
        </div>
      </div>
    );
  },
);
