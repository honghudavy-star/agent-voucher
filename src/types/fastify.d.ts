import "fastify";
import type { SessionContext } from "@agent-voucher/access-workspace";

declare module "fastify" {
  interface FastifyRequest {
    sessionContext: SessionContext | null;
  }
}
