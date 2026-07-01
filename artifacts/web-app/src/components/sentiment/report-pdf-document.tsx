import { forwardRef } from "react";
import type {
  TopicAnalysisDetail,
  TopicTheme,
  FlaggedComment,
  RepresentativeComment,
  TopicAnalysisPost,
} from "@workspace/api-client-react";
import { fmtDateTime } from "@/lib/utils";
import { detectPlatform, platformLabel, platformHexColor } from "@/lib/platform";

/* ── Formal light-theme palette (independent of the app's dark UI) ── */
const INK = "#111111";
const MUTED = "#555555";
const ACCENT = "#0d7a5f";
const DANGER = "#b91c1c";
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

function Author({ author, permalink }: { author: string; permalink: string }) {
  const platform = detectPlatform(permalink);
  return (
    <span style={{ fontSize: 11, color: MUTED, fontFamily: FONT }}>
      <span style={{ color: platformHexColor(platform), fontWeight: 700 }}>
        {platformLabel(platform)}
      </span>
      {author}
    </span>
  );
}

function Quote({
  comment,
  variant,
}: {
  comment: RepresentativeComment | FlaggedComment;
  variant: "rep" | "flagged";
}) {
  const isFlagged = variant === "flagged";
  return (
    <div
      style={{
        background: isFlagged ? "#fff8f8" : "#f8fafc",
        borderLeft: `3px solid ${isFlagged ? DANGER : ACCENT}`,
        padding: "8px 12px",
        marginTop: 8,
      }}
    >
      {isFlagged && "issue" in comment && (
        <div
          style={{
            display: "inline-block",
            fontSize: 10,
            fontWeight: 700,
            color: DANGER,
            border: `1px solid ${DANGER}`,
            borderRadius: 3,
            padding: "1px 6px",
            marginBottom: 6,
          }}
        >
          {comment.issue}
        </div>
      )}
      <p style={{ margin: 0, fontStyle: "italic", fontSize: 12.5 }}>
        &ldquo;{comment.excerpt}&rdquo;
      </p>
      <div style={{ marginTop: 6 }}>
        <Author author={comment.author} permalink={comment.permalink} />
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 10,
          color: ACCENT,
          wordBreak: "break-all",
        }}
      >
        {comment.permalink}
      </div>
    </div>
  );
}

function ThemeBlock({ theme }: { theme: TopicTheme }) {
  return (
    <div style={section} data-pdf-section>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          borderBottom: `1px solid ${BORDER}`,
          paddingBottom: 6,
          marginBottom: 8,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{theme.name}</h3>
        <span style={{ fontSize: 12, fontWeight: 700, color: ACCENT, whiteSpace: "nowrap" }}>
          {theme.percentage}% · {theme.commentCount} comments
        </span>
      </div>
      <ul style={{ margin: "0 0 4px", paddingLeft: 18 }}>
        {theme.summary.map((point, i) => (
          <li key={i} style={{ fontSize: 12.5, marginBottom: 3 }}>
            {point}
          </li>
        ))}
      </ul>
      {theme.representativeComments.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={sectionLabel}>Representative Comments</div>
          {theme.representativeComments.map((c, i) => (
            <Quote key={i} comment={c} variant="rep" />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Light-themed, formal rendering of a topic report, revealed only in the native
 * print dialog (window.print()) via the `print-document` class. Intentionally
 * carries no product branding, site name, or URLs in the page header/footer.
 */
export const ReportPdfDocument = forwardRef<HTMLDivElement, { detail: TopicAnalysisDetail }>(
  function ReportPdfDocument({ detail }, ref) {
    const result = detail.result;
    const posts: TopicAnalysisPost[] = detail.posts ?? [];
    const themeHints = detail.themeHints ?? [];

    return (
      <div ref={ref} style={page}>
        {/* Title + meta */}
        <div style={section} data-pdf-section>
          <h1
            style={{
              margin: 0,
              fontSize: 24,
              fontWeight: 800,
              letterSpacing: "0.04em",
            }}
          >
            Sentiment Analysis
          </h1>
          <div
            style={{
              height: 3,
              width: 70,
              background: ACCENT,
              margin: "8px 0 12px",
            }}
          />
          <p style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>
            {detail.topicSummary}
          </p>
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
            <Stat label="Posts" value={String(detail.postCount)} />
            <Stat label="Comments" value={String(detail.commentCount)} />
            <Stat label="Completed" value={fmtDateTime(detail.completedAt)} />
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
            <span style={{ fontWeight: 700 }}>Steering: </span>
            {themeHints.length > 0
              ? themeHints.join(", ")
              : "Automatic"}
            {detail.themeCount != null && ` · ${detail.themeCount} themes`}
          </div>
        </div>

        {result && (
          <>
            {/* Executive summary */}
            <div style={section} data-pdf-section>
              <div style={sectionLabel}>Executive Summary</div>
              <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-line" }}>
                {result.executiveSummary}
              </p>
            </div>

            {/* Themes */}
            <div style={section} data-pdf-section>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 800 }}>
                Themes
              </h2>
            </div>
            {result.themes.map((theme, i) => (
              <ThemeBlock key={i} theme={theme} />
            ))}

            {/* Flagged */}
            {result.flagged.length > 0 && (
              <div style={section} data-pdf-section>
                <div style={{ ...sectionLabel, color: DANGER }}>
                  Comments Requiring Attention
                </div>
                {result.flagged.map((f, i) => (
                  <Quote key={i} comment={f} variant="flagged" />
                ))}
              </div>
            )}

            {/* Posts analysed */}
            {posts.length > 0 && (
              <div style={section} data-pdf-section>
                <div style={sectionLabel}>Posts Analysed</div>
                {posts.map((p, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "5px 0",
                      borderBottom: `1px solid ${BORDER}`,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ wordBreak: "break-all", color: ACCENT }}>
                      {p.url}
                    </span>
                    <span style={{ color: MUTED, whiteSpace: "nowrap" }}>
                      {p.commentCount} comments
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  },
);

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 800, color: ACCENT }}>{value}</div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: MUTED,
        }}
      >
        {label}
      </div>
    </div>
  );
}
