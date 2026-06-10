import { type RequestHandler } from "express";

import { polarClient } from "../lib/polar";
import { getWeeklyPlanStatus, isPolarNotFound } from "../lib/polar-state";

export const weeklyPlanMiddleware: RequestHandler = (_req, res, next) => {
  const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";

  if (!userId) {
    return res.status(401).json({ error: "unauthorized" });
  }

  void (async () => {
    try {
      const customerState = await polarClient.customers.getStateExternal({
        externalId: userId
      });

      if (!getWeeklyPlanStatus(customerState).active) {
        return res.status(402).json({ error: "weekly_plan_required" });
      }

      return next();
    } catch (error) {
      if (isPolarNotFound(error)) {
        return res.status(402).json({ error: "weekly_plan_required" });
      }

      return next(error);
    }
  })();
};
