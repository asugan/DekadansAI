import { type RequestHandler } from "express";

import { resolveWeeklyPlanStatus } from "../lib/subscription-entitlements";

export const weeklyPlanMiddleware: RequestHandler = (_req, res, next) => {
  const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";

  if (!userId) {
    return res.status(401).json({ error: "unauthorized" });
  }

  void (async () => {
    try {
      const planStatus = await resolveWeeklyPlanStatus(userId);

      if (!planStatus.active || !planStatus.tier) {
        return res.status(402).json({ error: "weekly_plan_required" });
      }

      res.locals.planTier = planStatus.tier;

      return next();
    } catch (error) {
      return next(error);
    }
  })();
};
