import { z } from "zod";
import { RoleSchema } from "@agent-voucher/shared-kernel";

export const BootstrapSchema = z.object({
  token: z.string().min(32).max(256),
  workspaceName: z.string().trim().min(1).max(120),
  ledgerName: z.string().trim().min(1).max(120),
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(256),
});

export const LoginSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(1).max(256),
});

export const CreateUserSchema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(256),
  roles: z.array(RoleSchema).min(1),
});

export const UpdateWorkspaceSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  ledgerName: z.string().trim().min(1).max(120),
  revision: z.coerce.number().int().min(1),
});

export const PeriodSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  status: z.enum(["OPEN", "CLOSED"]),
});

export const UpdatePeriodSchema = z.object({
  status: z.enum(["OPEN", "CLOSED"]),
  revision: z.coerce.number().int().min(1),
});

export const MasterDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("supplier"), code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(120), accountTail: z.string().optional(), expenseWhitelisted: z.coerce.boolean().optional(),
  }),
  z.object({
    type: z.literal("bank-account"), accountTail: z.string().regex(/^\d{2,8}$/),
    name: z.string().trim().min(1).max(120), code: z.string().optional(), expenseWhitelisted: z.coerce.boolean().optional(),
  }),
  z.object({
    type: z.literal("account"), code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(120), accountTail: z.string().optional(), expenseWhitelisted: z.coerce.boolean().optional(),
  }),
]);

export type BootstrapInput = z.infer<typeof BootstrapSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceSchema>;
export type PeriodInput = z.infer<typeof PeriodSchema>;
export type UpdatePeriodInput = z.infer<typeof UpdatePeriodSchema>;
export type MasterDataInput = z.infer<typeof MasterDataSchema>;
