import { expect, it } from "vitest";
import { applyStructure } from "./rowExtract.js";
import { toRows } from "./rows.js";

const FLAT = `goto('https://x.org/')\nfill('Телефон', '747')\nclick('Продолжить')\nclick('Готово')\n`;
const GROUPED = `step('Вход', () => {\n  fill('Телефон', '747')\n  click('Продолжить')\n})\nclick('Готово')\n`;

it("wraps a run of rows into a section", () => {
  const rows = toRows(FLAT);
  const ids = rows
    .filter((r) => ["fill", "click"].includes(r.action!) && r.args[0]?.value !== "Готово")
    .map((r) => r.id);
  const { code } = applyStructure(FLAT, { kind: "group", ids, name: "Вход" });

  expect(code).toBe(`goto('https://x.org/')\n${GROUPED}`);
});

it("unwraps a section back to flat rows", () => {
  const { code } = applyStructure(GROUPED, { kind: "ungroup", section: "Вход" });
  expect(code).toBe(`fill('Телефон', '747')\nclick('Продолжить')\nclick('Готово')\n`);
});

it("renames a section without touching its body", () => {
  const { code } = applyStructure(GROUPED, { kind: "rename", section: "Вход", name: "Авторизация" });
  expect(code).toBe(GROUPED.replace("'Вход'", "'Авторизация'"));
});

it("extracts a section into its own script and calls it", () => {
  const { code, extracted } = applyStructure(GROUPED, { kind: "extract", section: "Вход" });

  expect(extracted).toEqual({
    path: "scripts/vhod.js",
    code: `fill('Телефон', '747')\nclick('Продолжить')\n`,
  });
  // Composition is run(), the step the DSL actually has.
  expect(code).toBe(`run('scripts/vhod.js')\nclick('Готово')\n`);
});

it("refuses to group rows that are not next to each other", () => {
  const rows = toRows(FLAT);
  const ids = [rows[0]!.id, rows[3]!.id];
  expect(() => applyStructure(FLAT, { kind: "group", ids, name: "X" })).toThrow(/подряд/);
});

const TWO = `step('Вход', () => {\n  click('A')\n})\nstep('Подача', () => {\n  click('B')\n})\nclick('C')\n`;

it("moves a whole section, not just its first step", () => {
  // The canvas is the mode for structure; without this it cannot reorder
  // anything, which is most of why it exists.
  const { code } = applyStructure(TWO, { kind: "moveSection", section: "Подача", before: "Вход" });

  expect(code).toBe(`step('Подача', () => {\n  click('B')\n})\nstep('Вход', () => {\n  click('A')\n})\nclick('C')\n`);
});

it("moves a section to the end", () => {
  const { code } = applyStructure(TWO, { kind: "moveSection", section: "Вход", before: null });

  expect(code).toBe(`step('Подача', () => {\n  click('B')\n})\nclick('C')\nstep('Вход', () => {\n  click('A')\n})\n`);
});
