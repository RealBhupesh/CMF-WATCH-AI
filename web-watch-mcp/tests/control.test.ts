import { describe, expect, it } from "vitest";
import { ToolBusyError, ToolControl } from "../src/control.js";

describe("tool control", () => {
  it("rejects overlap and releases the owner after failures", async () => {
    const control = new ToolControl();
    let finish!: () => void;
    const first = control.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    await expect(control.run(async () => "overlap")).rejects.toBeInstanceOf(ToolBusyError);
    finish();
    await first;
    await expect(control.run(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(control.run(async () => "recovered")).resolves.toBe("recovered");
  });
});
