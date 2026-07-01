import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { CreateAccountBody, UpdateAccountBody } from "@workspace/api-zod";
import {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  getUser,
  countAdmins,
  listLoginAttempts,
} from "../lib/auth";

const router: IRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

router.use("/admin/accounts", requireAdmin);
router.use("/admin/login-attempts", requireAdmin);

router.get("/admin/accounts", async (_req, res): Promise<void> => {
  const accounts = await listAccounts();
  res.json({ accounts });
});

router.post("/admin/accounts", async (req, res): Promise<void> => {
  const parsed = CreateAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const username = parsed.data.username.trim();
  const { password, role } = parsed.data;
  if (username === "") {
    res.status(400).json({ error: "Username cannot be empty" });
    return;
  }
  const existing = await getUser(username);
  if (existing) {
    res.status(409).json({ error: "An account with that username already exists" });
    return;
  }
  await createAccount(username, password, role);
  res.status(201).json({ username, role });
});

router.patch("/admin/accounts/:username", async (req, res): Promise<void> => {
  const parsed = UpdateAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const username = req.params.username;
  const target = await getUser(username);
  if (!target) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const { role, password } = parsed.data;
  // Block demoting the only admin so the system can never be left without one.
  if (role && role !== "admin" && target.role === "admin" && (await countAdmins()) <= 1) {
    res.status(400).json({ error: "Cannot demote the last admin account" });
    return;
  }
  await updateAccount(username, { role, password });
  const updated = await getUser(username);
  if (!updated) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json({
    username: updated.username,
    role: updated.role,
    createdAt: updated.createdAt.toISOString(),
  });
});

router.delete("/admin/accounts/:username", async (req, res): Promise<void> => {
  const username = req.params.username;
  if (username === req.session.user) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }
  const target = await getUser(username);
  if (!target) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  if (target.role === "admin" && (await countAdmins()) <= 1) {
    res.status(400).json({ error: "Cannot delete the last admin account" });
    return;
  }
  await deleteAccount(username);
  res.json({ ok: true });
});

router.get("/admin/login-attempts", async (req, res): Promise<void> => {
  const page = Math.max(0, Number(req.query["page"]) || 0);
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"]) || 5));
  const { attempts, total } = await listLoginAttempts(page * limit, limit);
  res.json({ attempts, total });
});

export default router;
