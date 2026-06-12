/**
 * AgentWorker — 개별 워커 프로세스 관리
 *
 * 에이전트 YAML을 로드하고 프로세스를 스폰하여 작업을 실행합니다.
 */

import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import type { DagNode } from "../contracts/dag.js";
import type { WorkerLogHandle } from "./log-streamer.js";
import { renderScopedAgentYaml, type AgentCapabilityScopes } from "../util/scoped-agent-file.js";
import { assignSkills, type SkillAssignment } from "./skill-assigner.js";
import { capabilityScopesFromRouting } from "./capability-routing.js";
import { buildChildEnv } from "../runtime/child-env.js";
import type { TaskRunContext } from "../contracts/worker-context.js";

export interface AgentWorkerOptions {
  node: DagNode;
  runId: string;
  agentYamlPath: string;
  logHandle: WorkerLogHandle;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  runContext?: TaskRunContext;
}

export interface WorkerOutput {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  metadata?: Record<string, unknown>;
}

export function buildAgentWorkerSpawnEnv(
  workerEnv: Record<string, string>,
  metadata: { readonly runId: string; readonly nodeId: string; readonly role: string }
): Record<string, string> {
  return buildChildEnv({
    parentEnv: process.env,
    overrideEnv: {
      ...workerEnv,
      OMK_RUN_ID: metadata.runId,
      OMK_NODE_ID: metadata.nodeId,
      OMK_NODE_ROLE: metadata.role,
    },
  });
}

export class AgentWorker {
  private node: DagNode;
  private runId: string;
  private agentYamlPath: string;
  private logHandle: WorkerLogHandle;
  private cwd: string;
  private env: Record<string, string>;
  private timeout: number;
  private runContext?: TaskRunContext;
  private process: ChildProcess | null = null;
  private abortController: AbortController | null = null;

  constructor(options: AgentWorkerOptions) {
    this.node = options.node;
    this.runId = options.runId;
    this.agentYamlPath = options.agentYamlPath;
    this.logHandle = options.logHandle;
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? {};
    this.timeout = options.timeout ?? 300000; // 5분 기본
    this.runContext = options.runContext;
  }

  /**
   * 워커 실행
   */
  async execute(): Promise<WorkerOutput> {
    this.abortController = new AbortController();

    const startTime = Date.now();

    // In-process execution via runtime bridge
    if (this.node.executionMode === "in-process") {
      this.logHandle.log("info", `Executing node in-process: ${this.node.id}`);

      const { createRuntimeBackedTaskRunner } = await import("../runtime/runtime-backed-task-runner.js");
      const runner = await createRuntimeBackedTaskRunner({
        cwd: this.cwd,
        env: this.env,
        runId: this.runId,
        goal: this.node.name,
      });

      const timeoutId =
        this.timeout > 0
          ? setTimeout(() => {
              if (!this.abortController?.signal.aborted) {
                this.logHandle.log("warn", `Worker timeout after ${this.timeout}ms, terminating...`);
                this.abort();
              }
            }, this.timeout)
          : undefined;

      try {
        const taskResult = await runner.run(this.node, this.env, this.abortController.signal, this.runContext);
        const duration = Date.now() - startTime;

        for (const line of taskResult.stdout.split("\n")) {
          if (line) this.logHandle.onStdout(line.trim());
        }
        for (const line of taskResult.stderr.split("\n")) {
          if (line) this.logHandle.onStderr(line.trim());
        }

        this.logHandle.log(
          taskResult.success ? "info" : "error",
          `Worker finished (${duration}ms)`
        );

        return {
          success: taskResult.success,
          exitCode: taskResult.exitCode ?? (taskResult.success ? 0 : 1),
          stdout: taskResult.stdout,
          stderr: taskResult.stderr,
          metadata: {
            ...(taskResult.metadata ?? {}),
            duration,
            nodeId: this.node.id,
            role: this.node.role,
            capabilityScopes: capabilityScopesFromRouting(this.node.routing),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logHandle.log("error", `Worker process error: ${message}`);
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    let stdout = "";
    let stderr = "";
    let exitCode = 1;

    return new Promise((resolve, reject) => {
      // omk 실행 명령어 구성
      const command = "node";
      const args = [
        join(__dirname, "..", "cli", "main.js"),
        "run",
        "--agent-yaml", this.agentYamlPath,
        "--node-id", this.node.id,
        "--run-id", this.runId,
      ];

      this.logHandle.log("info", `Spawning worker: ${command} ${args.join(" ")}`);

      try {
        this.process = spawn(command, args, {
          cwd: this.cwd,
          env: buildAgentWorkerSpawnEnv(this.env, {
            runId: this.runId,
            nodeId: this.node.id,
            role: this.node.role,
          }),
          stdio: ["pipe", "pipe", "pipe"],
          signal: this.abortController!.signal,
        });

        // stdout 처리
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const line = chunk.toString("utf-8");
          stdout += line;
          this.logHandle.onStdout(line.trim());
        });

        // stderr 처리
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const line = chunk.toString("utf-8");
          stderr += line;
          this.logHandle.onStderr(line.trim());
        });

        // 프로세스 종료 처리
        this.process.on("close", (code) => {
          exitCode = code ?? 1;
          const duration = Date.now() - startTime;

          this.logHandle.log(
            exitCode === 0 ? "info" : "error",
            `Worker finished with exit code ${exitCode} (${duration}ms)`
          );

          resolve({
            success: exitCode === 0,
            exitCode,
            stdout,
            stderr,
            metadata: {
              duration,
              nodeId: this.node.id,
              role: this.node.role,
            },
          });
        });

        // 프로세스 에러 처리
        this.process.on("error", (error) => {
          this.logHandle.log("error", `Worker process error: ${error.message}`);
          reject(error);
        });

        // 타임아웃 설정
        if (this.timeout > 0) {
          setTimeout(() => {
            if (this.process && !this.process.killed) {
              this.logHandle.log("warn", `Worker timeout after ${this.timeout}ms, terminating...`);
              this.abort();
            }
          }, this.timeout);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logHandle.log("error", `Failed to spawn worker: ${message}`);
        reject(error);
      }
    });
  }

  /**
   * 워커 중단
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      // 3초 후 강제 종료
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 3000);
    }
  }

  /**
   * 워커가 실행 중인지 확인
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null;
  }

  /**
   * 프로세스 ID 가져오기
   */
  getPid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * 노드 정보 가져오기
   */
  getNode(): DagNode {
    return this.node;
  }
}

/**
 * 에이전트 YAML 파일 생성
 */
export async function createAgentYaml(
  node: DagNode,
  runId: string,
  skills: SkillAssignment,
  outputDir: string
): Promise<string> {
  const yamlPath = join(outputDir, `${node.id}.yaml`);
  const scopes = capabilityScopesFromRouting(node.routing, skills);

  const capabilities: AgentCapabilityScopes = {
    mcpScope: node.routing?.mcpServers?.length ? "none" : "project",
    skillsScope: node.routing?.skills?.length ? "none" : "project",
    hooksScope: node.routing?.hooks?.length ? "project" : "project",
    skillNames: [...scopes.skills],
    mcpNames: [...scopes.mcpServers],
    toolNames: [...scopes.tools],
    hookNames: [...scopes.hooks],
  };

  const baseAgentFile = join(outputDir, "..", "..", "..", "..", ".omk", "agents", "root.yaml");
  const outputFile = yamlPath;

  const yaml = renderScopedAgentYaml({
    baseAgentFile,
    outputFile,
    role: node.role,
    name: node.name,
    resources: capabilities,
  });

  const { writeFile } = await import("fs/promises");
  await writeFile(yamlPath, yaml, "utf-8");

  return yamlPath;
}

/**
 * 워커 생성 헬퍼
 */
export async function createAgentWorker(
  node: DagNode,
  runId: string,
  logHandle: WorkerLogHandle,
  options: Partial<AgentWorkerOptions> = {}
): Promise<AgentWorker> {
  // 스킬 할당
  const skills = assignSkills(node);

  // 에이전트 YAML 생성
  const outputDir = options.cwd
    ? join(options.cwd, ".omk", "runs", runId, "agents")
    : join(".omk", "runs", runId, "agents");

  const { mkdir } = await import("fs/promises");
  await mkdir(outputDir, { recursive: true });

  const agentYamlPath = await createAgentYaml(node, runId, skills, outputDir);

  logHandle.log("info", `Created agent YAML: ${agentYamlPath}`);
  const scopes = capabilityScopesFromRouting(node.routing, skills);
  logHandle.log("info", `Assigned skills: ${scopes.skills.join(", ")}`);
  logHandle.log("info", `Assigned MCP servers: ${scopes.mcpServers.join(", ")}`);
  logHandle.log("info", `Assigned hooks: ${scopes.hooks.join(", ")}`);
  if (node.routing?.skills?.length) {
    logHandle.log("info", `Routing override skills: ${node.routing.skills.join(", ")}`);
  }
  if (node.routing?.mcpServers?.length) {
    logHandle.log("info", `Routing override MCPs: ${node.routing.mcpServers.join(", ")}`);
  }
  if (node.routing?.hooks?.length) {
    logHandle.log("info", `Routing override hooks: ${node.routing.hooks.join(", ")}`);
  }

  return new AgentWorker({
    node,
    runId,
    agentYamlPath,
    logHandle,
    ...options,
  });
}
