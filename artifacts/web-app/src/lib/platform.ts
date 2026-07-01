export type Platform =
  | "reddit"
  | "facebook"
  | "instagram"
  | "tiktok"
  | "unknown";

export function detectPlatform(url: string): Platform {
  const u = (url ?? "").toLowerCase();
  if (u.includes("reddit.com")) return "reddit";
  if (u.includes("facebook.com") || u.includes("fb.com")) return "facebook";
  if (u.includes("instagram.com") || u.includes("instagr.am")) return "instagram";
  if (u.includes("tiktok.com")) return "tiktok";
  return "unknown";
}

export function platformIcon(platform: Platform): string {
  switch (platform) {
    case "reddit":
      return "\u2b24";
    case "facebook":
      return "f";
    case "instagram":
      return "\u25cb";
    case "tiktok":
      return "\u25e6";
    default:
      return "\u25a0";
  }
}

export function platformLabel(platform: Platform): string {
  switch (platform) {
    case "reddit":
      return "u/";
    case "facebook":
      return "fb/";
    case "instagram":
      return "ig/";
    case "tiktok":
      return "tt/";
    default:
      return "";
  }
}

export function platformIconColor(platform: Platform): string {
  switch (platform) {
    case "reddit":
      return "text-orange-500";
    case "facebook":
      return "text-blue-500";
    case "instagram":
      return "text-pink-500";
    case "tiktok":
      return "text-cyan-400";
    default:
      return "text-muted-foreground";
  }
}

export function platformHexColor(platform: Platform): string {
  switch (platform) {
    case "reddit":
      return "#f97316";
    case "facebook":
      return "#3b82f6";
    case "instagram":
      return "#ec4899";
    case "tiktok":
      return "#06b6d4";
    default:
      return "#555555";
  }
}
