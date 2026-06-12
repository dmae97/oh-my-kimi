export type TerminalOwnerState = "idle" | "readline" | "child" | "raw-selector";

export interface TerminalInputOwnerLike {
  pause(): unknown;
  resume(): unknown;
}

export interface ReadlineOwnerLike {
  pause(): unknown;
  resume(): unknown;
  prompt?(preserveCursor?: boolean): unknown;
}

export class TerminalOwner {
  private active: TerminalOwnerState = "idle";

  constructor(private readonly input: TerminalInputOwnerLike = process.stdin) {}

  get state(): TerminalOwnerState {
    return this.active;
  }

  claimReadline(): () => void {
    this.assertCanOwn("readline");
    this.active = "readline";
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.active === "readline") this.active = "idle";
    };
  }

  async withChildProcess<T>(readline: ReadlineOwnerLike | undefined, fn: () => Promise<T>): Promise<T> {
    if (this.active !== "idle" && this.active !== "readline") {
      throw new Error(`Terminal already owned by ${this.active}; cannot start child`);
    }

    const previous = this.active;
    this.active = "child";
    try {
      try {
        readline?.pause();
      } catch {
        // Piped input can close readline before queued work finishes.
      }
      try {
        this.input.pause();
      } catch {
        // Non-standard test streams may already be closed.
      }
      return await fn();
    } finally {
      try {
        this.input.resume();
      } catch {
        // EOF/non-TTY test harnesses can close stdin while a child-owned task is settling.
      }
      try {
        readline?.resume();
      } catch {
        // Readline may already be closed after piped input EOF; ownership must still reset.
      }
      this.active = previous;
    }
  }

  private assertCanOwn(next: TerminalOwnerState): void {
    if (this.active !== "idle") {
      throw new Error(`Terminal already owned by ${this.active}; cannot start ${next}`);
    }
  }
}
