import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

interface RedditUserLinkProps {
  username: string;
  className?: string;
  /** Show the small external-link icon that opens the real Reddit profile. */
  showIcon?: boolean;
  /** When true (default), the username links to the internal dossier page. */
  dossier?: boolean;
}

/**
 * Renders a username. By default the name links to the internal dossier
 * (/users/<username>), with a small external-link icon that opens the user's
 * real Reddit profile (https://reddit.com/u/<username>) in a new tab.
 */
export function RedditUserLink({ username, className, showIcon = true, dossier = true }: RedditUserLinkProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {dossier ? (
        <Link
          href={`/reddit-users/${username}`}
          onClick={(e) => e.stopPropagation()}
          className="hover:text-primary transition-colors"
        >
          {username}
        </Link>
      ) : (
        <span>{username}</span>
      )}
      {showIcon && (
        <a
          href={`https://www.reddit.com/u/${username}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-muted-foreground hover:text-primary transition-colors"
          title="View on Reddit"
          aria-label={`View ${username} on Reddit`}
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </span>
  );
}
