/** One owner/browser per deployment. Reject overlap instead of replaying stale actions later. */
export class ToolBusyError extends Error {
  constructor() {
    super("Another tool call is running. Wait for it to finish, take a fresh snapshot, then retry.");
    this.name = "ToolBusyError";
  }
}

export class ToolControl {
  private busy = false;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ToolBusyError();
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }
}
