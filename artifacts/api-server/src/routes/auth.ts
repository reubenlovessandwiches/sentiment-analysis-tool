import { Router, type IRouter } from "express";
import {
  getUser,
  verifyPassword,
  recordLoginAttempt,
  clientIp,
} from "../lib/auth";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const { username, password } = req.body ?? {};
  const ip = clientIp(req);

  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password required" });
    return;
  }

  const user = await getUser(username);
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;

  await recordLoginAttempt(username, ok, ip);

  if (ok && user) {
    // Regenerate the session on login to prevent session fixation: any
    // pre-login session id is discarded and a fresh one is bound to the user.
    req.session.regenerate((err) => {
      if (err) {
        req.log.error({ err }, "failed to regenerate session on login");
        res.status(500).json({ error: "Login failed, please try again" });
        return;
      }
      req.session.user = user.username;
      req.session.role = user.role;
      res.json({ username: user.username, role: user.role });
    });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

router.get("/auth/me", (req, res): void => {
  if (!req.session.user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json({ username: req.session.user, role: req.session.role ?? "member" });
});

router.post("/auth/logout", (req, res): void => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

export default router;
