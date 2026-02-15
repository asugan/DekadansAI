import { type NextFunction, type Request, type RequestHandler, type Response } from "express";

type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

export function asyncHandler(fn: AsyncRouteHandler): RequestHandler {
  return function wrappedAsyncHandler(req, res, next) {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
