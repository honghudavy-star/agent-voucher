export type GraphOperation =
  | { kind: "smoke"; processId: string; revision: number; threadId: string }
  | { kind: "health" }
  | { kind: "backup"; destination: string }
  | { kind: "close" };

export interface GraphRequest { id: number; operation: GraphOperation }
export interface GraphResponse { id: number; ok: boolean; value?: unknown; error?: string }
