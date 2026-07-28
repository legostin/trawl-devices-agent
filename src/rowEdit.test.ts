import { expect, it } from "vitest";
import { applyCommand } from "./rowEdit.js";
import { toRows } from "./rows.js";

const CODE = `// recorded by trawl-devices-agent
goto('https://x.org/')
step('Вход', () => {
  fill('Телефон', '7472957230')
  click('Продолжить')
})
click('Готово')
`;

const id = (code: string, action: string, nth = 0): string =>
  toRows(code).filter((r) => r.action === action)[nth]!.id;

it("changes one argument and leaves every other byte alone", () => {
  const out = applyCommand(CODE, { kind: "setArg", id: id(CODE, "fill"), index: 1, value: "7000000000" });

  expect(out).toBe(CODE.replace("'7472957230'", "'7000000000'"));
});

it("disables a row by commenting it out, keeping its indentation", () => {
  const out = applyCommand(CODE, { kind: "setDisabled", id: id(CODE, "click"), disabled: true });

  expect(out).toContain("  // click('Продолжить')");
  // And back again.
  const back = applyCommand(out, {
    kind: "setDisabled",
    id: toRows(out).find((r) => r.disabled)!.id,
    disabled: false,
  });
  expect(back).toBe(CODE);
});

it("removes a row and the line it sat on", () => {
  const out = applyCommand(CODE, { kind: "remove", id: id(CODE, "click", 1) });

  expect(out).not.toContain("Готово");
  expect(out.split("\n").filter((l) => l.trim() === "")).toHaveLength(1); // trailing newline only
});

it("moves a row to another place, keeping its own text", () => {
  const rows = toRows(CODE);
  const goodbye = rows.find((r) => r.args[0]?.value === "Готово")!;
  const phone = rows.find((r) => r.action === "fill")!;
  const out = applyCommand(CODE, { kind: "move", id: goodbye.id, before: phone.id });

  const order = toRows(out)
    .filter((r) => r.kind === "step")
    .map((r) => r.args[0]?.value);
  expect(order).toEqual(["https://x.org/", "Готово", "Телефон", "Продолжить"]);
  // Moved into a section, it picks up that section's indentation.
  expect(out).toContain("  click('Готово')");
});

it("inserts a new step before a row, in that row's section", () => {
  const out = applyCommand(CODE, {
    kind: "insert",
    before: id(CODE, "click"),
    action: "fill",
    args: ["Пароль", "1234567"],
  });

  expect(out).toContain("  fill('Пароль', '1234567')\n  click('Продолжить')");
});

it("appends when there is no row to insert before", () => {
  const out = applyCommand(CODE, { kind: "insert", before: null, action: "expectUrl", args: ["**/done"] });
  expect(out.trimEnd().endsWith("expectUrl('**/done')")).toBe(true);
});

it("refuses to rewrite an argument it cannot round-trip", () => {
  const code = `fill('Цена', env.PRICE)\n`;
  expect(() => applyCommand(code, { kind: "setArg", id: id(code, "fill"), index: 1, value: "1" })).toThrow(
    /выражение/,
  );
});

it("moves a row forward, where every id after it has shifted", () => {
  const rows = toRows(CODE);
  const goto = rows.find((r) => r.action === "goto")!;
  const goodbye = rows.find((r) => r.args[0]?.value === "Готово")!;

  // Cutting the goto out renumbers everything below it: an anchor re-found in
  // the shortened source would be the wrong row.
  const out = applyCommand(CODE, { kind: "move", id: goto.id, before: goodbye.id });

  expect(
    toRows(out)
      .filter((r) => r.kind === "step")
      .map((r) => r.args[0]?.value),
  ).toEqual(["Телефон", "Продолжить", "https://x.org/", "Готово"]);
});
