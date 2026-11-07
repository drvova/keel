// What omp-vcc says to the user (src/host.ts): a UI that is gone is no error,
// and a message the host refuses to send is told, not lost.
import { describe, expect, it } from "bun:test";
import { deliver, tell } from "../src/host";

const ui = () => {
  const told: Array<[string, string]> = [];
  return { told, ctx: { hasUI: true, ui: { notify: (m: string, t: string) => told.push([m, t]) } } as any };
};

describe("tell", () => {
  it("is quiet when the UI is gone", () => {
    expect(() => tell({ hasUI: true, ui: { notify: () => { throw new Error("gone"); } } } as any, "x")).not.toThrow();
  });
});

describe("deliver", () => {
  it("sends at once", () => {
    const { ctx } = ui();
    let sent = false;
    void deliver(ctx, "the prompt", () => { sent = true; });
    expect(sent).toBe(true);
  });

  it("tells what the host refused to send, thrown or rejected", async () => {
    const { ctx, told } = ui();
    await deliver(ctx, "the follow-up prompt", () => { throw new Error("busy"); });
    await deliver(ctx, "the pin to the agent", () => Promise.reject(new Error("closed")));
    expect(told).toEqual([
      ["omp-vcc: could not send the follow-up prompt: busy", "warning"],
      ["omp-vcc: could not send the pin to the agent: closed", "warning"],
    ]);
  });
});
