export type CliUiEvent =
  | {
      type: "session:start";
      runId: string;
      provider: string;
      model?: string;
      layout?: string;
      root?: string;
      cwd?: string;
      rootSource?: string;
    }
  | {
      type: "input:submitted";
      text: string;
    }
  | {
      type: "prompt:ready";
    }
  | {
      type: "control:output";
      text: string;
    }
  | {
      type: "turn:route";
      provider: string;
      model?: string;
      risk: string;
      sandbox: string;
      mcp?: readonly string[];
      skills?: readonly string[];
      hooks?: readonly string[];
    }
  | {
      type: "turn:start";
      nodeId: string;
    }
  | {
      type: "turn:heartbeat";
      elapsedMs: number;
      provider?: string;
      model?: string;
    }
  | {
      type: "assistant:final";
      text: string;
    }
  | {
      type: "turn:error";
      message: string;
    }
  | {
      type: "turn:finish";
      durationMs: number;
      exitCode: number;
    }
  | {
      type: "session:stop";
      exitCode: number;
    }
  | {
      type: "turn:todo";
      total: number;
      done: number;
      inProgress: number;
      items: readonly { title: string; status: string }[];
    }
  | {
      type: "turn:reasoning";
      summary: string;
      frames: readonly { text: string; elapsedMs?: number }[];
    };
