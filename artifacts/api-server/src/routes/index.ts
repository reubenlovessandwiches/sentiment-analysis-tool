import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import adminAccountsRouter from "./admin-accounts";
import dashboardRouter from "./dashboard";
import subredditsRouter from "./subreddits";
import usersRouter from "./users";
import compareRouter from "./compare";
import archetypesRouter from "./archetypes";
import searchRouter from "./search";
import jobsRouter from "./jobs";
import settingsRouter from "./settings";
import topicAnalysesRouter from "./topic-analyses";
import facebookRouter from "./facebook";
import instagramRouter from "./instagram";
import tiktokRouter from "./tiktok";
import twitterRouter from "./twitter";
import youtubeRouter from "./youtube";
import financeRouter from "./finance";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);

router.use((req: Request, res: Response, next: NextFunction): void => {
  if (req.path.startsWith("/auth") || req.path.startsWith("/health")) {
    next();
    return;
  }
  if (!req.session.user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
});

router.use(adminAccountsRouter);
router.use(dashboardRouter);
router.use(subredditsRouter);
router.use(usersRouter);
router.use(compareRouter);
router.use(archetypesRouter);
router.use(searchRouter);
router.use(jobsRouter);
router.use(settingsRouter);
router.use(topicAnalysesRouter);
router.use(facebookRouter);
router.use(instagramRouter);
router.use(tiktokRouter);
router.use(twitterRouter);
router.use(youtubeRouter);
router.use(financeRouter);

export default router;
