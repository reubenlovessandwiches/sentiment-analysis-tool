import { useState } from "react";
import {
  useListAccounts,
  useCreateAccount,
  useUpdateAccount,
  useDeleteAccount,
  useListLoginAttempts,
  getListAccountsQueryKey,
  getListLoginAttemptsQueryKey,
  getMe,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import type {
  CreateAccountBodyRole,
  UpdateAccountBodyRole,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Pager } from "@/components/pager";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Users,
  UserPlus,
  Trash2,
  Pencil,
  ShieldCheck,
  User as UserIcon,
  Check,
  X,
  ShieldAlert,
} from "lucide-react";

const ATTEMPTS_PER_PAGE = 5;

// Login-attempt timestamps are stored UTC; operators view them in UTC.
function formatGmt8(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

export default function UserManagement() {
  const { data: me, isLoading: meLoading } = useQuery({
    queryKey: getGetMeQueryKey(),
    queryFn: () => getMe(),
    retry: false,
  });

  if (meLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (me?.role !== "admin") {
    return (
      <div className="max-w-md mx-auto mt-20 text-center space-y-3">
        <ShieldAlert className="w-10 h-10 text-destructive mx-auto" />
        <h1 className="text-xl font-bold">Access Restricted</h1>
        <p className="text-sm text-muted-foreground">
          User Management is available to the main admin only.
        </p>
      </div>
    );
  }

  return <UserManagementContent currentUser={me.username} />;
}

function UserManagementContent({ currentUser }: { currentUser: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const accountsQuery = useListAccounts();
  const createAccount = useCreateAccount();
  const updateAccount = useUpdateAccount();
  const deleteAccount = useDeleteAccount();

  const [page, setPage] = useState(0);
  const attemptsQuery = useListLoginAttempts({ page, limit: ATTEMPTS_PER_PAGE });

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<CreateAccountBodyRole>("member");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<UpdateAccountBodyRole>("member");
  const [editPassword, setEditPassword] = useState("");

  const openEdit = (acc: { username: string; role: string }) => {
    setEditTarget(acc.username);
    setEditRole(acc.role as UpdateAccountBodyRole);
    setEditPassword("");
  };

  const accounts = accountsQuery.data?.accounts ?? [];
  const attempts = attemptsQuery.data?.attempts ?? [];
  const total = attemptsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / ATTEMPTS_PER_PAGE));

  const refreshAccounts = () =>
    queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
  const refreshAttempts = () =>
    queryClient.invalidateQueries({
      queryKey: getListLoginAttemptsQueryKey(),
    });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    createAccount.mutate(
      { data: { username: username.trim(), password, role } },
      {
        onSuccess: () => {
          toast({ title: "Account created", description: `${username.trim()} (${role})` });
          setUsername("");
          setPassword("");
          setRole("member");
          refreshAccounts();
        },
        onError: () => {
          toast({
            title: "Could not create account",
            description: "Username may already be taken.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleDelete = (target: string) => {
    deleteAccount.mutate(
      { username: target },
      {
        onSuccess: () => {
          toast({ title: "Account deleted", description: target });
          refreshAccounts();
        },
        onError: () => {
          toast({
            title: "Could not delete account",
            description: "You cannot delete yourself or the last admin.",
            variant: "destructive",
          });
        },
        onSettled: () => setPendingDelete(null),
      },
    );
  };

  const handleEdit = () => {
    if (!editTarget) return;
    const data: { role?: UpdateAccountBodyRole; password?: string } = {
      role: editRole,
    };
    if (editPassword) data.password = editPassword;
    updateAccount.mutate(
      { username: editTarget, data },
      {
        onSuccess: () => {
          toast({ title: "Account updated", description: editTarget });
          setEditTarget(null);
          refreshAccounts();
        },
        onError: () => {
          toast({
            title: "Could not update account",
            description:
              "The change was rejected — you cannot demote the last admin.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="bg-primary/10 p-2 rounded-md border border-primary/20">
          <Users className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">User Management</h1>
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
            Accounts &amp; access log
          </p>
        </div>
      </div>

      {/* Create account */}
      <Card className="glass border-border/50">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground uppercase tracking-wider">
            <UserPlus className="w-3.5 h-3.5" />
            Add Account
          </div>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleCreate}
            className="flex flex-col sm:flex-row sm:items-end gap-3"
          >
            <div className="flex-1 space-y-1.5">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Username
              </label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="bg-background/50 font-mono"
                placeholder="new-user"
                autoComplete="off"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Password
              </label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-background/50 font-mono"
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Role
              </label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as CreateAccountBodyRole)}
              >
                <SelectTrigger className="w-36 bg-background/50 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              type="submit"
              disabled={createAccount.isPending || !username.trim() || !password}
              className="font-mono"
            >
              {createAccount.isPending ? "ADDING…" : "ADD"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Accounts list */}
      <Card className="glass border-border/50">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground uppercase tracking-wider">
              <Users className="w-3.5 h-3.5" />
              Accounts
            </div>
            <span className="text-xs font-mono text-muted-foreground">
              {accounts.length} TOTAL
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {accountsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground py-4">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No accounts.</p>
          ) : (
            <div className="divide-y divide-border/50">
              {accounts.map((acc) => {
                const isSelf = acc.username === currentUser;
                return (
                  <div
                    key={acc.username}
                    className="flex items-center justify-between py-3"
                  >
                    <div className="flex items-center gap-3">
                      {acc.role === "admin" ? (
                        <ShieldCheck className="w-4 h-4 text-primary" />
                      ) : (
                        <UserIcon className="w-4 h-4 text-muted-foreground" />
                      )}
                      <div>
                        <div className="font-mono text-sm">
                          {acc.username}
                          {isSelf && (
                            <span className="text-muted-foreground"> (you)</span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono">
                          last seen {acc.lastSeen ? formatGmt8(acc.lastSeen) : "never"}
                        </div>
                      </div>
                      <Badge
                        variant={acc.role === "admin" ? "default" : "secondary"}
                        className="font-mono text-[10px] uppercase"
                      >
                        {acc.role}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(acc)}
                        aria-label={`Edit ${acc.username}`}
                        className="text-muted-foreground hover:text-primary"
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isSelf}
                        onClick={() => setPendingDelete(acc.username)}
                        aria-label={`Delete ${acc.username}`}
                        className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Login attempts */}
      <Card className="glass border-border/50">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground uppercase tracking-wider">
              <ShieldCheck className="w-3.5 h-3.5" />
              Login Attempts
            </div>
            <span className="text-xs font-mono text-muted-foreground">
              {total} TOTAL · UTC
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {attemptsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground py-4">Loading…</p>
          ) : attempts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No login attempts recorded yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] font-mono uppercase tracking-wider text-muted-foreground border-b border-border/50">
                    <th className="py-2 pr-4 font-medium">Result</th>
                    <th className="py-2 pr-4 font-medium">Username</th>
                    <th className="py-2 pr-4 font-medium">IP Address</th>
                    <th className="py-2 font-medium">Time (UTC)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {attempts.map((a) => (
                    <tr key={a.id}>
                      <td className="py-2.5 pr-4">
                        {a.success ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400 font-mono text-xs">
                            <Check className="w-3.5 h-3.5" /> SUCCESS
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-destructive font-mono text-xs">
                            <X className="w-3.5 h-3.5" /> FAILED
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 font-mono">{a.username}</td>
                      <td className="py-2.5 pr-4 font-mono text-muted-foreground">
                        {a.ipAddress ?? "—"}
                      </td>
                      <td className="py-2.5 font-mono text-muted-foreground tabular-nums">
                        {formatGmt8(a.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={page} pageCount={pageCount} onPageChange={setPage} />
        </CardContent>
      </Card>

      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => !open && setEditTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit account</DialogTitle>
            <DialogDescription>
              Update the role or reset the password for{" "}
              <span className="font-mono">{editTarget}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Role
              </label>
              <Select
                value={editRole}
                onValueChange={(v) => setEditRole(v as UpdateAccountBodyRole)}
              >
                <SelectTrigger className="bg-background/50 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                New password
              </label>
              <Input
                type="password"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                className="bg-background/50 font-mono"
                placeholder="Leave blank to keep current"
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleEdit}
              disabled={updateAccount.isPending}
              className="font-mono"
            >
              {updateAccount.isPending ? "SAVING…" : "SAVE"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes{" "}
              <span className="font-mono">{pendingDelete}</span> and revokes their
              access. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingDelete && handleDelete(pendingDelete)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
