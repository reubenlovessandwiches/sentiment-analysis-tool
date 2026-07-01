import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

interface TikTokUserLinkProps {
  username: string;
  displayName: string;
  /** Real TikTok profile URL for the external-link icon, when available. */
  profileUrl?: string | null;
  className?: string;
  /** Show the small external-link icon that opens the real TikTok profile. */
  showIcon?: boolean;
  /** When true (default), the name links to the internal dossier page. */
  dossier?: boolean;
}

/**
 * Renders an TikTok profile's display name. By default the name links to the
 * internal dossier (/tiktok-users/<username>), with a small external-link
 * icon that opens the user's real TikTok profile in a new tab when a
 * profileUrl is available.
 */
export function TikTokUserLink({
  username,
  displayName,
  profileUrl,
  className,
  showIcon = true,
  dossier = true,
}: TikTokUserLinkProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {dossier ? (
        <Link
          href={`/tiktok-users/${encodeURIComponent(username)}`}
          onClick={(e) => e.stopPropagation()}
          className="hover:text-primary transition-colors"
        >
          {displayName}
        </Link>
      ) : (
        <span>{displayName}</span>
      )}
      {showIcon && profileUrl && (
        <a
          href={profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-muted-foreground hover:text-primary transition-colors"
          title="View on TikTok"
          aria-label={`View ${displayName} on TikTok`}
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </span>
  );
}
