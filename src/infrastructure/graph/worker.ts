import { parentPort, workerData } from "node:worker_threads";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { GraphRequest, GraphResponse } from "./protocol.js";

const data = workerData as { graphPath: string };
const saver = SqliteSaver.fromConnString(data.graphPath);

const State = Annotation.Root({
  processId: Annotation<string>(),
  revision: Annotation<number>(),
  status: Annotation<string>(),
  errorCode: Annotation<string | null>(),
});

const graph = new StateGraph(State)
  .addNode("validate_runtime", (state) => ({
    processId: state.processId,
    revision: state.revision,
    status: "SUCCEEDED",
    errorCode: null,
  }))
  .addEdge(START, "validate_runtime")
  .addEdge("validate_runtime", END)
  .compile({ checkpointer: saver });

async function handle(request: GraphRequest): Promise<unknown> {
  switch (request.operation.kind) {
    case "smoke": {
      const state = await graph.invoke({
        processId: request.operation.processId,
        revision: request.operation.revision,
        status: "RUNNING",
        errorCode: null,
      }, { configurable: { thread_id: request.operation.threadId } });
      const encoded = JSON.stringify(state);
      if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error("GRAPH_STATE_TOO_LARGE");
      return state;
    }
    case "health": return { ready: true, database: data.graphPath };
    case "backup": await saver.db.backup(request.operation.destination); return { destination: request.operation.destination };
    case "close": saver.db.close(); return { closed: true };
  }
}

if (!parentPort) throw new Error("Graph worker requires parentPort");
const port = parentPort;
port.on("message", (request: GraphRequest) => {
  void handle(request).then(
    (value) => port.postMessage({ id: request.id, ok: true, value } satisfies GraphResponse),
    (error: unknown) => port.postMessage({
      id: request.id, ok: false, error: error instanceof Error ? error.message : "Graph worker failed",
    } satisfies GraphResponse),
  );
});
