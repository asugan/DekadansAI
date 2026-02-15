import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";

import { auth } from "./auth";
import { config } from "./config";
import { HttpError } from "./lib/errors";
import { authMiddleware } from "./middleware/auth";
import { accountRouter } from "./routes/account";
import { aiRouter } from "./routes/ai";

const app = express();

if (config.trustProxy) {
  app.set("trust proxy", true);
}

app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((item) => item.trim()),
    credentials: true
  })
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.all("/api/auth/*", toNodeHandler(auth));

app.use(express.json({ limit: "2mb" }));

app.use("/account", accountRouter);

app.use("/ai", authMiddleware, aiRouter);

app.use((_req, _res, next) => {
  next(new HttpError("not found", 404));
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const statusCode = err instanceof HttpError ? err.statusCode : 500;
  const response: { error: string; details?: unknown } = {
    error: err instanceof Error ? err.message : "internal server error"
  };

  if (err instanceof HttpError && err.details) {
    response.details = err.details;
  }

  if (!(err instanceof HttpError)) {
    response.details = {
      message: err instanceof Error ? err.message : "Unexpected error"
    };
  }

  res.status(statusCode).json(response);
};

app.use(errorHandler);

export { app };
