import type { FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";

export function publicBase(ctx: AppContext, req: FastifyRequest): string {
  return ctx.config.publicUrl || `${req.protocol}://${req.host}`;
}
