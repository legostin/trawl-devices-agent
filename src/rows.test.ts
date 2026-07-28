import { expect, it } from "vitest";
import { toRows } from "./rows.js";

it("reads flat steps, with their literal arguments", () => {
  const rows = toRows(`goto('https://x.org/')\nfill('Цена', '30000')\n`);

  expect(rows.map((r) => [r.action, r.args.map((a) => a.value)])).toEqual([
    ["goto", ["https://x.org/"]],
    ["fill", ["Цена", "30000"]],
  ]);
  expect(rows.every((r) => r.kind === "step" && !r.disabled)).toBe(true);
  expect(rows[0]!.line).toBe(1);
  expect(rows[1]!.line).toBe(2);
});

it("gives every row the source text it came from", () => {
  const code = `click('A')\nclick( 'B' )\n`;
  const rows = toRows(code);
  expect(rows.map((r) => r.raw)).toEqual(["click('A')", "click( 'B' )"]);
  expect(code.slice(...rows[1]!.range)).toBe("click( 'B' )");
});

it("flattens a step() block into rows that remember their section", () => {
  const rows = toRows(`step('Вход', () => {\n  click('A')\n  click('B')\n})\nclick('C')\n`);

  expect(rows.map((r) => [r.action, r.section])).toEqual([
    ["click", "Вход"],
    ["click", "Вход"],
    ["click", undefined],
  ]);
});

it("keeps what it cannot model as an opaque code row", () => {
  const rows = toRows(`click('A')\nif (count('X') > 1) { click('B') }\nclick('C')\n`);

  expect(rows.map((r) => r.kind)).toEqual(["step", "code", "step"]);
  expect(rows[1]!.raw).toBe("if (count('X') > 1) { click('B') }");
});

it("marks a commented-out step as a disabled row rather than losing it", () => {
  const rows = toRows(`click('A')\n// click('B')\nclick('C')\n`);

  expect(rows.map((r) => [r.action, r.disabled])).toEqual([
    ["click", false],
    ["click", true],
    ["click", false],
  ]);
});

it("says which arguments it cannot round-trip", () => {
  const rows = toRows(`fill('Цена', env.PRICE)\n`);
  expect(rows[0]!.args.map((a) => a.literal)).toEqual([true, false]);
  expect(rows[0]!.args[1]!.value).toBe("env.PRICE");
});
