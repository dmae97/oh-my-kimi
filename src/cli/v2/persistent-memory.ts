/**
 * Section 17 — Persistent Project Memory
 *
 * 프로젝트 폴더로 들어가면 이전 세션의 상태를 자동 복원:
 * - last session, open todos, decisions, current branch, known failure patterns
 *
 * Memory Mount Flow:
 *   cwd → ProjectRootResolver → ProjectIdResolver → MemoryStore.open(projectId)
 *   → ProjectStateCapsule load → Intent-specific retrieval → Context injection
 *
 * Storage: .omk/memory/*.md (human-readable, git-friendly)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// --- Types ---

export interface CapsuleTodo {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
  readonly priority: "high" | "medium" | "low";
  readonly createdAt: string;
}

export interface CapsuleDecision {
  readonly id: string;
  readonly summary: string;
  readonly rationale: string;
  readonly decidedAt: string;
  readonly reversible: boolean;
}

export interface ProjectStateCapsule {
  readonly projectId: string;
  readonly rootPath: string;
  readonly projectName: string;
  readonly currentBranch?: string;

  readonly lastSession?: {
    readonly sessionId: string;
    readonly endedAt: string;
    readonly summary: string;
    readonly lastGoal?: string;
  };

  readonly activeTodos: readonly CapsuleTodo[];
  readonly recentDecisions: readonly CapsuleDecision[];
  readonly projectInvariants: readonly string[];
  readonly preferredCommands: readonly string[];
  readonly knownFailurePatterns: readonly string[];
  readonly importantFiles: readonly string[];
  readonly openQuestions: readonly string[];

  readonly updatedAt: string;
}

export interface MemoryStoreOptions {
  readonly cwd: string;
  readonly memoryDir?: string;
}

export interface MemorySearchResult {
  readonly file: string;
  readonly matches: readonly { line: number; text: string }[];
}

// --- Memory Store ---

export interface PersistentMemoryStore {
  load(): Promise<ProjectStateCapsule>;
  save(capsule: Partial<ProjectStateCapsule>): Promise<void>;
  appendDecision(decision: Omit<CapsuleDecision, "id" | "decidedAt">): Promise<void>;
  appendTodo(todo: Omit<CapsuleTodo, "id" | "createdAt">): Promise<void>;
  search(query: string): Promise<MemorySearchResult[]>;
  clear(): Promise<void>;
  getMemoryDir(): string;
}

/**
 * Create a persistent memory store for the given project.
 */
export function createPersistentMemoryStore(
  options: MemoryStoreOptions,
): PersistentMemoryStore {
  const memoryDir =
    options.memoryDir ?? path.join(options.cwd, ".omk", "memory");

  return {
    async load() {
      return loadCapsule(memoryDir, options.cwd);
    },

    async save(partial) {
      const existing = await loadCapsule(memoryDir, options.cwd);
      const merged = { ...existing, ...partial, updatedAt: new Date().toISOString() };
      await saveCapsule(memoryDir, merged);
    },

    async appendDecision(decision) {
      const existing = await loadCapsule(memoryDir, options.cwd);
      const newDecision: CapsuleDecision = {
        ...decision,
        id: generateId(),
        decidedAt: new Date().toISOString(),
      };
      const updated = {
        ...existing,
        recentDecisions: [...existing.recentDecisions, newDecision].slice(-20),
        updatedAt: new Date().toISOString(),
      };
      await saveCapsule(memoryDir, updated);
      await appendToLog(memoryDir, "decisions.md", formatDecision(newDecision));
    },

    async appendTodo(todo) {
      const existing = await loadCapsule(memoryDir, options.cwd);
      const newTodo: CapsuleTodo = {
        ...todo,
        id: generateId(),
        createdAt: new Date().toISOString(),
      };
      const updated = {
        ...existing,
        activeTodos: [...existing.activeTodos, newTodo].slice(-50),
        updatedAt: new Date().toISOString(),
      };
      await saveCapsule(memoryDir, updated);
    },

    async search(query) {
      return searchMemory(memoryDir, query);
    },

    async clear() {
      if (fs.existsSync(memoryDir)) {
        fs.rmSync(memoryDir, { recursive: true, force: true });
      }
    },

    getMemoryDir() {
      return memoryDir;
    },
  };
}

// --- Internal ---

const EMPTY_CAPSULE: ProjectStateCapsule = {
  projectId: "",
  rootPath: "",
  projectName: "",
  activeTodos: [],
  recentDecisions: [],
  projectInvariants: [],
  preferredCommands: [],
  knownFailurePatterns: [],
  importantFiles: [],
  openQuestions: [],
  updatedAt: "",
};

async function loadCapsule(
  memoryDir: string,
  cwd: string,
): Promise<ProjectStateCapsule> {
  const capsulePath = path.join(memoryDir, "state.json");

  if (!fs.existsSync(capsulePath)) {
    return {
      ...EMPTY_CAPSULE,
      projectId: resolveProjectId(cwd),
      rootPath: cwd,
      projectName: path.basename(cwd),
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const raw = fs.readFileSync(capsulePath, "utf-8");
    return JSON.parse(raw) as ProjectStateCapsule;
  } catch {
    return {
      ...EMPTY_CAPSULE,
      projectId: resolveProjectId(cwd),
      rootPath: cwd,
      projectName: path.basename(cwd),
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveCapsule(
  memoryDir: string,
  capsule: ProjectStateCapsule,
): Promise<void> {
  fs.mkdirSync(memoryDir, { recursive: true });

  // Save JSON state
  const capsulePath = path.join(memoryDir, "state.json");
  fs.writeFileSync(capsulePath, JSON.stringify(capsule, null, 2) + "\n");

  // Save human-readable markdown
  const mdPath = path.join(memoryDir, "project.md");
  fs.writeFileSync(mdPath, formatCapsuleAsMarkdown(capsule));
}

async function appendToLog(
  memoryDir: string,
  filename: string,
  content: string,
): Promise<void> {
  fs.mkdirSync(memoryDir, { recursive: true });
  const logPath = path.join(memoryDir, filename);
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  fs.writeFileSync(logPath, existing + content + "\n");
}

async function searchMemory(
  memoryDir: string,
  query: string,
): Promise<MemorySearchResult[]> {
  if (!fs.existsSync(memoryDir)) {
    return [];
  }

  const results: MemorySearchResult[] = [];
  const files = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
  const lowerQuery = query.toLowerCase();

  for (const file of files) {
    const filePath = path.join(memoryDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const matches: { line: number; text: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerQuery)) {
        matches.push({ line: i + 1, text: lines[i] });
      }
    }

    if (matches.length > 0) {
      results.push({ file, matches });
    }
  }

  return results;
}

function resolveProjectId(cwd: string): string {
  // Use git remote URL or directory hash as project ID
  const gitDir = path.join(cwd, ".git");
  if (fs.existsSync(gitDir)) {
    try {
      const config = fs.readFileSync(path.join(gitDir, "config"), "utf-8");
      const remoteMatch = config.match(/url\s*=\s*(.+)/);
      if (remoteMatch) {
        return crypto
          .createHash("sha256")
          .update(remoteMatch[1].trim())
          .digest("hex")
          .slice(0, 12);
      }
    } catch {
      // fall through
    }
  }

  return crypto
    .createHash("sha256")
    .update(cwd)
    .digest("hex")
    .slice(0, 12);
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// --- Formatters ---

function formatCapsuleAsMarkdown(capsule: ProjectStateCapsule): string {
  const lines: string[] = [
    `# Project: ${capsule.projectName}`,
    "",
    `**Project ID:** ${capsule.projectId}`,
    `**Root:** ${capsule.rootPath}`,
    `**Updated:** ${capsule.updatedAt}`,
    "",
  ];

  if (capsule.lastSession) {
    lines.push(
      "## Last Session",
      `- **Session:** ${capsule.lastSession.sessionId}`,
      `- **Ended:** ${capsule.lastSession.endedAt}`,
      `- **Summary:** ${capsule.lastSession.summary}`,
      "",
    );
  }

  if (capsule.activeTodos.length > 0) {
    lines.push("## Active Todos");
    for (const todo of capsule.activeTodos) {
      lines.push(`- [${todo.status === "completed" ? "x" : " "}] ${todo.content} (${todo.priority})`);
    }
    lines.push("");
  }

  if (capsule.recentDecisions.length > 0) {
    lines.push("## Recent Decisions");
    for (const d of capsule.recentDecisions) {
      lines.push(`- **${d.summary}** — ${d.rationale} (${d.decidedAt})`);
    }
    lines.push("");
  }

  if (capsule.knownFailurePatterns.length > 0) {
    lines.push("## Known Failure Patterns");
    for (const p of capsule.knownFailurePatterns) {
      lines.push(`- ${p}`);
    }
    lines.push("");
  }

  if (capsule.importantFiles.length > 0) {
    lines.push("## Important Files");
    for (const f of capsule.importantFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatDecision(decision: CapsuleDecision): string {
  return [
    `## ${decision.summary}`,
    `- **ID:** ${decision.id}`,
    `- **Date:** ${decision.decidedAt}`,
    `- **Rationale:** ${decision.rationale}`,
    `- **Reversible:** ${decision.reversible ? "yes" : "no"}`,
    "",
  ].join("\n");
}
