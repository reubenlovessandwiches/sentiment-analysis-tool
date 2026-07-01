export type SentimentPrefill = {
  topicSummary: string;
  inputUrls: string[];
  themeHints: string[];
  themeCount: number | null;
};

const KEY = "sentiment-prefill";

export function stashPrefill(p: SentimentPrefill) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

export function takePrefill(): SentimentPrefill | null {
  try {
    const v = sessionStorage.getItem(KEY);
    if (!v) return null;
    sessionStorage.removeItem(KEY);
    return JSON.parse(v) as SentimentPrefill;
  } catch {
    return null;
  }
}
