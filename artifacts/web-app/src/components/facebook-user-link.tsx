import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

interface FacebookUserLinkProps {
  profileId: string;
  displayName: string;
  /** Real Facebook profile URL for the external-link icon, when available. */
  profileUrl?: string | null;
  className?: string;
  /** Show the small external-link icon that opens the real Facebook profile. */
  showIcon?: boolean;
  /** When true (default), the name links to the internal dossier page. */
  dossier?: boolean;
}

/**
 * Renders a Facebook profile's display name. By default the name links to the
 * internal dossier (/facebook-users/<profileId>), with a small external-link
 * icon that opens the user's real Facebook profile in a new tab when a
 * profileUrl is available.
 */
export function FacebookUserLink({
  profileId,
  displayName,
  profileUrl,
  className,
  showIcon = true,
  dossier = true,
}: FacebookUserLinkProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {dossier ? (
        <Link
          href={`/facebook-users/${encodeURIComponent(profileId)}`}
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
          title="View on Facebook"
          aria-label={`View ${displayName} on Facebook`}
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </span>
  );
}
