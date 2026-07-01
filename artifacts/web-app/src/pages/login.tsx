import { useState } from "react";
import { useLogin } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Rocket, Lock } from "lucide-react";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const queryClient = useQueryClient();
  const login = useLogin();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    login.mutate({ data: { username, password } }, {
      onSuccess: () => {
        queryClient.invalidateQueries();
      },
      onError: () => {
        setError("Invalid credentials.");
      },
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background relative overflow-hidden">
      <div
        className="pointer-events-none fixed bottom-0 right-0 z-0"
        style={{
          width: "260px",
          height: "210px",
          backgroundImage: "none",
          backgroundSize: "contain",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "bottom right",
          opacity: 0.12,
          mixBlendMode: "screen",
        }}
      />
      <div className="relative z-10 w-full max-w-sm space-y-6 px-4">
        <div className="flex flex-col items-center gap-3">
          <div className="bg-primary/10 p-3 rounded-xl border border-primary/20">
            <Rocket className="w-8 h-8 text-primary" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">ASTRO ORBITER</h1>
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mt-1">Operations Center — Restricted Access</p>
          </div>
        </div>

        <Card className="glass border-border/50">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground uppercase tracking-wider">
              <Lock className="w-3.5 h-3.5" />
              Authenticate
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Username</label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="bg-background/50 font-mono"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Password</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="bg-background/50 font-mono"
                  required
                />
              </div>
              {error && (
                <p className="text-xs text-destructive font-mono">{error}</p>
              )}
              <Button
                type="submit"
                className="w-full font-mono bg-primary hover:bg-primary/90 text-primary-foreground"
                disabled={login.isPending}
              >
                {login.isPending ? "AUTHENTICATING…" : "ENTER OPERATIONS CENTER"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
