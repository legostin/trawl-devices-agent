import { describe, expect, it } from "vitest";
import { addAwaits, hasBranching, unknownCalls } from "./transform.js";

const STEPS = ["goto", "click", "fill", "getText", "step", "note"];

describe("addAwaits", () => {
  it("awaits a bare step call", () => {
    expect(addAwaits("goto('/a')\n", STEPS)).toBe("await goto('/a')\n");
  });

  it("awaits step calls inside control flow", () => {
    const out = addAwaits("if (x) { click({ css: 'b' }) }\nfor (const i of [1]) { note('n') }", STEPS);
    expect(out).toContain("{ await click(");
    expect(out).toContain("{ await note(");
  });

  it("does not double-await", () => {
    expect(addAwaits("await goto('/a')", STEPS)).toBe("await goto('/a')");
  });

  it("leaves member calls and unknown functions alone", () => {
    const code = "helper(); obj.click(); console.log('click(')";
    expect(addAwaits(code, STEPS)).toBe(code);
  });

  it("awaits a step used as an expression", () => {
    expect(addAwaits("const t = getText({ testId: 'g' })", STEPS)).toBe("const t = await getText({ testId: 'g' })");
  });

  it("awaits nested step calls and makes their callback async", () => {
    const out = addAwaits("step('login', () => { fill({ label: 'Email' }, 'a'); click({ testId: 's' }) })", STEPS);
    expect(out).toBe(
      "await step('login', async () => { await fill({ label: 'Email' }, 'a'); await click({ testId: 's' }) })",
    );
  });

  it("leaves an already-async callback alone", () => {
    const out = addAwaits("step('x', async () => { goto('/a') })", STEPS);
    expect(out).toBe("await step('x', async () => { await goto('/a') })");
  });

  it("makes a named helper function async", () => {
    const out = addAwaits("function login() { goto('/a') }\nlogin()", STEPS);
    expect(out).toBe("async function login() { await goto('/a') }\nlogin()");
  });

  it("makes method shorthand async before the key", () => {
    const out = addAwaits("const o = { login() { goto('/a') } }", STEPS);
    expect(out).toBe("const o = { async login() { await goto('/a') } }");
  });

  it("reports a syntax error as a script error", () => {
    expect(() => addAwaits("goto('/a'", STEPS)).toThrow(/syntax error/i);
  });
});

describe("analysis", () => {
  it("detects branching", () => {
    expect(hasBranching("goto('/a')")).toBe(false);
    expect(hasBranching("if (1) { goto('/a') }")).toBe(true);
    expect(hasBranching("for (const x of []) { goto('/a') }")).toBe(true);
    expect(hasBranching("const u = a ? 1 : 2")).toBe(true);
  });

  it("lists calls that are neither steps, locals, nor allowed globals", () => {
    expect(unknownCalls("goto('/a'); clickk({}); console.log(1)", STEPS, ["console"])).toEqual(["clickk"]);
    expect(unknownCalls("function helper() {} helper()", STEPS, [])).toEqual([]);
    expect(unknownCalls("const helper = () => {}; helper()", STEPS, [])).toEqual([]);
  });
});
