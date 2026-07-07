import { useState } from "react";
import { Link, useLocation } from "wouter";
import { 
  Settings, 
  Network,
  LogOut,
  Home,
  FileText,
  ChevronDown,
  Users,
  DollarSign,
} from "lucide-react";
import { SiFacebook, SiInstagram, SiTiktok, SiX, SiYoutube } from "react-icons/si";
import { FaRedditAlien } from "react-icons/fa";
import { useLogout, getGetMeQueryKey, getMe } from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";

function NavSection({ label, icon: Icon, children }: { label: string; icon?: React.ElementType; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 mb-1.5 group"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider group-hover:text-foreground transition-colors">
          {Icon && <Icon className="w-3.5 h-3.5" />}
          {label}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && <div className="space-y-1 pl-3 ml-1.5 border-l border-border/50">{children}</div>}
    </div>
  );
}

function NavLink({ href, label, icon: Icon, exact }: { href: string; label: string; icon?: React.ElementType; exact?: boolean }) {
  const [location] = useLocation();
  const isActive = exact ? location === href : (location === href || (href !== "/" && location.startsWith(href)));
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all ${
        isActive
          ? "bg-primary/15 text-primary shadow-[inset_2px_0_0_0_hsl(var(--primary))] border border-primary/10"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
      }`}
    >
      {Icon && <Icon className="w-4 h-4" />}
      {label}
    </Link>
  );
}

export function Sidebar() {
  const queryClient = useQueryClient();
  const logout = useLogout();
  const { data: me } = useQuery({
    queryKey: getGetMeQueryKey(),
    queryFn: () => getMe(),
    retry: false,
  });
  const isAdmin = me?.role === "admin";

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.setQueryData(getGetMeQueryKey(), null);
        queryClient.invalidateQueries();
      },
    });
  };

  return (
    <div className="no-print flex flex-col w-64 h-full border-r border-border bg-card/50 glass">
      <div className="p-6 flex items-center gap-3 border-b border-border/50">
        <div className="bg-primary/10 p-2 rounded-md border border-primary/20">
          <Network className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="font-bold text-lg tracking-tight text-foreground">APP</h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-mono">Operations Center</p>
        </div>
      </div>

      <nav className="flex-1 py-4 px-3 overflow-y-auto">
        <NavLink href="/" label="Home" icon={Home} exact />

        <NavSection label="Sentiments" icon={FileText}>
          <NavLink href="/sentiment-analysis" label="Analyze" />
          <NavLink href="/sentiment-reports" label="Reports" />
        </NavSection>

        <NavSection label="Reddit" icon={FaRedditAlien}>
          <NavLink href="/reddit-overview" label="Overview" />
          <NavLink href="/reddit-investigate" label="Investigate" />
          <NavLink href="/reddit-users" label="Users" />
          <NavLink href="/reddit-archetypes" label="Archetypes" />
        </NavSection>

        <NavSection label="Facebook" icon={SiFacebook}>
          <NavLink href="/facebook-overview" label="Overview" />
          <NavLink href="/facebook-users" label="Users" />
          <NavLink href="/facebook-archetypes" label="Archetypes" />
        </NavSection>

        <NavSection label="Instagram" icon={SiInstagram}>
          <NavLink href="/instagram-overview" label="Overview" />
          <NavLink href="/instagram-users" label="Users" />
          <NavLink href="/instagram-archetypes" label="Archetypes" />
        </NavSection>

        <NavSection label="TikTok" icon={SiTiktok}>
          <NavLink href="/tiktok-overview" label="Overview" />
          <NavLink href="/tiktok-users" label="Users" />
          <NavLink href="/tiktok-archetypes" label="Archetypes" />
        </NavSection>

        <NavSection label="Twitter" icon={SiX}>
          <NavLink href="/twitter-overview" label="Overview" />
          <NavLink href="/twitter-users" label="Users" />
          <NavLink href="/twitter-archetypes" label="Archetypes" />
        </NavSection>

        <NavSection label="YouTube" icon={SiYoutube}>
          <NavLink href="/youtube-overview" label="Overview" />
          <NavLink href="/youtube-users" label="Users" />
          <NavLink href="/youtube-archetypes" label="Archetypes" />
        </NavSection>

        <div className="mt-5">
          <NavLink href="/admin" label="Admin Panel" icon={Settings} />
          {isAdmin && (
            <>
              <NavLink href="/finance" label="Finance" icon={DollarSign} />
              <NavLink href="/user-management" label="User Management" icon={Users} />
            </>
          )}
        </div>
      </nav>

      <div className="p-4 border-t border-border/50 bg-background/30">
        <button
          onClick={handleLogout}
          disabled={logout.isPending}
          className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs font-mono text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
        >
          <LogOut className="w-3.5 h-3.5" />
          {logout.isPending ? "LOGGING OUT…" : "LOGOUT"}
        </button>
      </div>
    </div>
  );
}
