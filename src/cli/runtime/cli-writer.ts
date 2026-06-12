/**
 * Phase 1 — CliWriter
 * All CLI output goes through here. No direct console.log/chalk anywhere else.
 * Wraps the existing OMK theme/style system for backward compatibility.
 */

import { appendFileSync } from "node:fs";
import { style, status } from "../../theme/index.js";
import type { OutputProfile, TaskStatus } from "./types.js";

export interface CliWriter {
  info(message: string): void;
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  agent(agentName: string, message: string): void;
  task(taskTitle: string, status: TaskStatus): void;
  trace(message: string): void;
  rawStdout(content: string): void;
  rawStderr(content: string): void;
}

const STATUS_ICON: Record<TaskStatus, string> = {
  running: "▶",
  pending: "◯",
  completed: "✓",
  failed: "✕",
};

function writeLine(stream: NodeJS.WriteStream, text: string): void {
  stream.write(text + "\n");
}

function writeFileLine(path: string, text: string): void {
  try {
    appendFileSync(path, text + "\n", "utf-8");
  } catch {
    // silently drop file-write failures; stdout remains the fallback
  }
}

export function createCliWriter(profile: OutputProfile): CliWriter {
  const isFile = profile.destination === "file" && profile.outputFile;
  const filePath = profile.outputFile;

  const out = (text: string): void => {
    if (isFile && filePath) {
      writeFileLine(filePath, text);
    } else {
      writeLine(process.stdout, text);
    }
  };

  const err = (text: string): void => {
    if (isFile && filePath) {
      writeFileLine(filePath, text);
    } else {
      writeLine(process.stderr, text);
    }
  };

  const raw = (stream: NodeJS.WriteStream, content: string): void => {
    if (isFile && filePath) {
      try {
        appendFileSync(filePath, content, "utf-8");
      } catch {
        /* ignore */
      }
    } else {
      stream.write(content);
    }
  };

  return {
    info(message: string): void {
      out(style.blue("ℹ ") + message);
    },

    success(message: string): void {
      out(status.success(message));
    },

    warning(message: string): void {
      err(status.warn(message));
    },

    error(message: string): void {
      err(status.fail(message));
    },

    agent(agentName: string, message: string): void {
      out(style.purple("● ") + style.bold + agentName + style.reset + ": " + message);
    },

    task(taskTitle: string, taskStatus: TaskStatus): void {
      const icon = STATUS_ICON[taskStatus] ?? "?";
      out(style.cyan(icon + " ") + taskTitle + " " + style.gray(`[${taskStatus}]`));
    },

    trace(message: string): void {
      out(style.dim + message + style.reset);
    },

    rawStdout(content: string): void {
      raw(process.stdout, content);
    },

    rawStderr(content: string): void {
      raw(process.stderr, content);
    },
  };
}
