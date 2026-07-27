import { expect, it } from "vitest";
import { generate, formatArg } from "./codegen.js";
import { collect } from "./sandbox.js";
import { isRegExp } from "./targets.js";

it("formats arguments as readable literals", () => {
  expect(formatArg("hi")).toBe("'hi'");
  expect(formatArg("it's")).toBe("'it\\'s'");
  expect(formatArg(42)).toBe("42");
  expect(formatArg({ testId: "submit" })).toBe("{ testId: 'submit' }");
  expect(formatArg({ role: "button", name: "Войти" })).toBe("{ role: 'button', name: 'Войти' }");
  expect(formatArg({ "data-x": 1 })).toBe("{ 'data-x': 1 }");
  expect(formatArg({ __regex: { source: "Привет", flags: "i" } })).toBe("/Привет/i");
  expect(formatArg({ within: { css: "#a" }, nth: 1 })).toBe("{ within: { css: '#a' }, nth: 1 }");
});

it("emits one call per line with setup separated", () => {
  const code = generate([
    { index: 0, action: "device", args: ["chrome-desktop"] },
    { index: 1, action: "use", args: [{ baseUrl: "https://app.test" }] },
    { index: 2, action: "goto", args: ["/login"] },
    { index: 3, action: "click", args: [{ testId: "submit" }] },
  ]);
  expect(code).toBe(
    "device('chrome-desktop')\n" +
      "use({ baseUrl: 'https://app.test' })\n" +
      "\n" +
      "goto('/login')\n" +
      "click({ testId: 'submit' })\n",
  );
});

it("prepends a header comment", () => {
  expect(generate([{ index: 0, action: "note", args: ["x"] }], { header: "recorded 2026-07-26" })).toBe(
    "// recorded 2026-07-26\nnote('x')\n",
  );
});

it("round-trips through collect", async () => {
  const steps = [
    { index: 0, action: "goto", args: ["/login"] },
    { index: 1, action: "fill", args: [{ label: "Email" }, "a@b.c"] },
    { index: 2, action: "expectText", args: [{ testId: "greeting" }, { __regex: { source: "Привет", flags: "" } }] },
  ];
  const result = await collect(generate(steps));
  expect(result.errors).toEqual([]);
  expect(result.steps.map((s) => s.action)).toEqual(["goto", "fill", "expectText"]);
  // The script ran inside node:vm, so its regex belongs to another realm:
  // instanceof would lie, hence the realm-agnostic check.
  expect(isRegExp(result.steps[2]!.args[1])).toBe(true);
  expect(String(result.steps[2]!.args[1])).toBe("/Привет/");
});

it("wraps consecutive steps of one section in a step() block", () => {
  const code = generate([
    { index: 0, action: "goto", args: ["https://x.org/a/new/"] },
    { index: 1, action: "select", args: ["Марка", "Volkswagen"], section: "Марка и модель" },
    { index: 2, action: "select", args: ["Год", "2010"], section: "Характеристики" },
    { index: 3, action: "click", args: ["Подать объявление"], section: "Характеристики" },
  ]);

  expect(code).toBe(
    [
      "goto('https://x.org/a/new/')",
      "step('Марка и модель', () => {",
      "  select('Марка', 'Volkswagen')",
      "})",
      "step('Характеристики', () => {",
      "  select('Год', '2010')",
      "  click('Подать объявление')",
      "})",
      "",
    ].join("\n"),
  );
});

it("returns to the top level when a section ends", () => {
  const code = generate([
    { index: 0, action: "click", args: ["A"], section: "Первый" },
    { index: 1, action: "click", args: ["B"] },
  ]);

  expect(code).toBe(["step('Первый', () => {", "  click('A')", "})", "click('B')", ""].join("\n"));
});
