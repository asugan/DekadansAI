import { type RequestHandler } from "express";

import { config } from "../config";

export const authMiddleware: RequestHandler = (req, res, next) => {
  if (!config.appApiKey) {
    return next();
  }

  const bearer = req.header("authorization") || "";
  const tokenFromBearer = bearer.toLowerCase().startsWith("bearer ")
    ? bearer.slice(7).trim()
    : "";
  const token = req.header("x-api-key") || tokenFromBearer;

  if (!token || token !== config.appApiKey) {
    return res.status(401).json({ error: "unauthorized" });
  }

  return next();
};
