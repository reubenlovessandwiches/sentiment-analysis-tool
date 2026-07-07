import { Link } from "wouter";
import {
  useGetDashboard,
  getGetDashboardQueryKey,
  useGetFacebookDashboard,
  getGetFacebookDashboardQueryKey,
  useGetInstagramDashboard,
  getGetInstagramDashboardQueryKey,
  useGetTikTokDashboard,
  getGetTikTokDashboardQueryKey,
  useGetTwitterDashboard,
  getGetTwitterDashboardQueryKey,
  useGetYoutubeDashboard,
  getGetYoutubeDashboardQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Network,
  Globe,
  Users,
  MessageSquare,
  ArrowRight,
} from "lucide-react";
import { SiFacebook, SiInstagram, SiTiktok, SiX, SiYoutube } from "react-icons/si";
import { FaRedditAlien } from "react-icons/fa";

function StatPill({ label, value }: { label: string; value?: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xl font-bold font-mono text-foreground">
        {value !== undefined ? value.toLocaleString() : "—"}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">{label}</span>
    </div>
  );
}

export default function Home() {
  const { data: reddit, isLoading: loadingReddit } = useGetDashboard(undefined, {
    query: { queryKey: getGetDashboardQueryKey() },
  });
  const { data: facebook, isLoading: loadingFacebook } = useGetFacebookDashboard({
    query: { queryKey: getGetFacebookDashboardQueryKey() },
  });
  const { data: instagram, isLoading: loadingInstagram } = useGetInstagramDashboard({
    query: { queryKey: getGetInstagramDashboardQueryKey() },
  });
  const { data: tiktok, isLoading: loadingTiktok } = useGetTikTokDashboard({
    query: { queryKey: getGetTikTokDashboardQueryKey() },
  });
  const { data: youtube, isLoading: loadingYoutube } = useGetYoutubeDashboard({
    query: { queryKey: getGetYoutubeDashboardQueryKey() },
  });
  const { data: twitter, isLoading: loadingTwitter } = useGetTwitterDashboard({
    query: { queryKey: getGetTwitterDashboardQueryKey() },
  });

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center gap-4">
        <div className="bg-primary/10 p-3 rounded-lg border border-primary/20">
          <Network className="w-7 h-7 text-primary" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Welcome to App</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">
            COMMUNITY INTELLIGENCE — MONITOR, CLASSIFY & COMPARE ONLINE DISCOURSE
          </p>
        </div>
      </div>

      <Card className="glass">
        <CardContent className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-accent/10 border border-accent/20">
              <Globe className="w-5 h-5 text-accent" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Sentiment Analysis</h3>
              <p className="text-sm text-muted-foreground">
                Drop Reddit, Facebook, Instagram, TikTok, X and YouTube post URLs together to surface themes and concerning comments.
              </p>
            </div>
          </div>
          <Link href="/sentiment-analysis">
            <Button className="font-mono text-xs whitespace-nowrap">
              <MessageSquare className="w-3.5 h-3.5 mr-2" /> START ANALYSIS
            </Button>
          </Link>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="glass border-primary/20 flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-primary/10 border border-primary/20">
                <FaRedditAlien className="w-5 h-5 text-primary" />
              </div>
              <div>
                <CardTitle>Reddit Intelligence</CardTitle>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col flex-1 gap-6">
            {loadingReddit ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <StatPill label="Users" value={reddit?.totalUsers} />
                <StatPill label="Posts" value={reddit?.totalPosts} />
                <StatPill label="Comments" value={reddit?.totalComments} />
              </div>
            )}
            <div className="mt-auto flex flex-wrap gap-2">
              <Link href="/reddit-overview">
                <Button variant="secondary" className="font-mono text-xs">
                  OPEN OVERVIEW <ArrowRight className="w-3.5 h-3.5 ml-2" />
                </Button>
              </Link>
              <Link href="/reddit-users">
                <Button variant="ghost" className="font-mono text-xs">
                  <Users className="w-3.5 h-3.5 mr-2" /> USERS
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-primary/20 flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-primary/10 border border-primary/20">
                <SiFacebook className="w-5 h-5 text-primary" />
              </div>
              <div>
                <CardTitle>Facebook Intelligence</CardTitle>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col flex-1 gap-6">
            {loadingFacebook ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <StatPill label="Users" value={facebook?.totalUsers} />
                <StatPill label="Posts" value={facebook?.totalPosts} />
                <StatPill label="Comments" value={facebook?.totalComments} />
              </div>
            )}
            <div className="mt-auto flex flex-wrap gap-2">
              <Link href="/facebook-overview">
                <Button variant="secondary" className="font-mono text-xs">
                  OPEN OVERVIEW <ArrowRight className="w-3.5 h-3.5 ml-2" />
                </Button>
              </Link>
              <Link href="/facebook-users">
                <Button variant="ghost" className="font-mono text-xs">
                  <Users className="w-3.5 h-3.5 mr-2" /> USERS
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-primary/20 flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-primary/10 border border-primary/20">
                <SiInstagram className="w-5 h-5 text-primary" />
              </div>
              <div>
                <CardTitle>Instagram Intelligence</CardTitle>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col flex-1 gap-6">
            {loadingInstagram ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <StatPill label="Users" value={instagram?.totalUsers} />
                <StatPill label="Posts" value={instagram?.totalPosts} />
                <StatPill label="Comments" value={instagram?.totalComments} />
              </div>
            )}
            <div className="mt-auto flex flex-wrap gap-2">
              <Link href="/instagram-overview">
                <Button variant="secondary" className="font-mono text-xs">
                  OPEN OVERVIEW <ArrowRight className="w-3.5 h-3.5 ml-2" />
                </Button>
              </Link>
              <Link href="/instagram-users">
                <Button variant="ghost" className="font-mono text-xs">
                  <Users className="w-3.5 h-3.5 mr-2" /> USERS
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-primary/20 flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-primary/10 border border-primary/20">
                <SiTiktok className="w-5 h-5 text-primary" />
              </div>
              <div>
                <CardTitle>TikTok Intelligence</CardTitle>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col flex-1 gap-6">
            {loadingTiktok ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <StatPill label="Users" value={tiktok?.totalUsers} />
                <StatPill label="Posts" value={tiktok?.totalPosts} />
                <StatPill label="Comments" value={tiktok?.totalComments} />
              </div>
            )}
            <div className="mt-auto flex flex-wrap gap-2">
              <Link href="/tiktok-overview">
                <Button variant="secondary" className="font-mono text-xs">
                  OPEN OVERVIEW <ArrowRight className="w-3.5 h-3.5 ml-2" />
                </Button>
              </Link>
              <Link href="/tiktok-users">
                <Button variant="ghost" className="font-mono text-xs">
                  <Users className="w-3.5 h-3.5 mr-2" /> USERS
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-primary/20 flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-primary/10 border border-primary/20">
                <SiX className="w-5 h-5 text-primary" />
              </div>
              <div>
                <CardTitle>X Intelligence</CardTitle>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col flex-1 gap-6">
            {loadingTwitter ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <StatPill label="Users" value={twitter?.totalUsers} />
                <StatPill label="Posts" value={twitter?.totalPosts} />
                <StatPill label="Comments" value={twitter?.totalComments} />
              </div>
            )}
            <div className="mt-auto flex flex-wrap gap-2">
              <Link href="/twitter-overview">
                <Button variant="secondary" className="font-mono text-xs">
                  OPEN OVERVIEW <ArrowRight className="w-3.5 h-3.5 ml-2" />
                </Button>
              </Link>
              <Link href="/twitter-users">
                <Button variant="ghost" className="font-mono text-xs">
                  <Users className="w-3.5 h-3.5 mr-2" /> USERS
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-primary/20 flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-primary/10 border border-primary/20">
                <SiYoutube className="w-5 h-5 text-primary" />
              </div>
              <div>
                <CardTitle>YouTube Intelligence</CardTitle>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col flex-1 gap-6">
            {loadingYoutube ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <StatPill label="Users" value={youtube?.totalUsers} />
                <StatPill label="Posts" value={youtube?.totalPosts} />
                <StatPill label="Comments" value={youtube?.totalComments} />
              </div>
            )}
            <div className="mt-auto flex flex-wrap gap-2">
              <Link href="/youtube-overview">
                <Button variant="secondary" className="font-mono text-xs">
                  OPEN OVERVIEW <ArrowRight className="w-3.5 h-3.5 ml-2" />
                </Button>
              </Link>
              <Link href="/youtube-users">
                <Button variant="ghost" className="font-mono text-xs">
                  <Users className="w-3.5 h-3.5 mr-2" /> USERS
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
