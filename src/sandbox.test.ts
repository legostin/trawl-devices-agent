import { describe, expect, it } from "vitest";
import { collect, runInSandbox } from "./sandbox.js";

describe("collect", () => {
  it("lists steps in order with their arguments", async () => {
    const result = await collect("device('chrome')\ngoto('/login')\nclick({ testId: 'submit' })\n");
    expect(result.approximate).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.steps).toEqual([
      { index: 0, action: "device", args: ["chrome"] },
      { index: 1, action: "goto", args: ["/login"] },
      { index: 2, action: "click", args: [{ testId: "submit" }] },
    ]);
  });

  it("descends into step(name, fn) and tags nested steps", async () => {
    const result = await collect("step('login', () => { goto('/l'); note('hi') })");
    expect(result.steps.map((s) => [s.action, s.name])).toEqual([
      ["step", undefined],
      ["goto", "login"],
      ["note", "login"],
    ]);
  });

  it("marks a branching script approximate", async () => {
    expect((await collect("if (1) { goto('/a') }")).approximate).toBe(true);
  });

  it("reports unknown steps without throwing", async () => {
    const result = await collect("goto('/a'); clik({})");
    expect(result.errors).toEqual([{ kind: "unknown-step", message: "unknown step: clik" }]);
  });

  it("reports a syntax error as an error entry", async () => {
    expect((await collect("goto('/a'")).errors[0]!.kind).toBe("syntax");
  });

  it("stops a runaway loop instead of hanging", async () => {
    const result = await collect("while (true) { note('x') }");
    expect(result.errors.some((e) => e.kind === "runtime")).toBe(true);
  });
});

describe("runInSandbox", () => {
  it("exposes only the provided scope", async () => {
    const seen: string[] = [];
    await runInSandbox("goto('/a')", { goto: async (u: string) => { seen.push(u); } }, 1000);
    expect(seen).toEqual(["/a"]);
  });

  it("denies access to require and process", async () => {
    await expect(
      runInSandbox(
        "note(typeof process)",
        { note: async (v: string) => { if (v !== "undefined") throw new Error(`process leaked: ${v}`); } },
        1000,
      ),
    ).resolves.toBeUndefined();
    await expect(runInSandbox("require('node:fs')", {}, 1000)).rejects.toThrow(/require/);
  });
});
