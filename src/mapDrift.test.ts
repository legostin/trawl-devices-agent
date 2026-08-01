import { expect, it } from "vitest";
import { compareDigest, coverage, screenUsage } from "./mapDrift.js";
import type { AppMap, ScreenFile } from "./mapTypes.js";
import type { RunReport, StepResult } from "./types.js";

const step = (screen?: string): StepResult => ({
  index: 0,
  action: "click",
  args: [],
  ...(screen ? { screen } : {}),
  status: "passed",
  startedAt: 0,
  durationMs: 1,
  flows: [],
});

const run = (script: string, screens: (string | undefined)[]): RunReport => ({
  runId: `r_${script}`,
  script,
  device: "d",
  status: "passed",
  startedAt: 0,
  durationMs: 1,
  steps: screens.map((s) => step(s)),
  artifacts: { trace: null, video: null },
  warnings: [],
});

const screen = (id: string, label: string, elements = 1): ScreenFile => ({
  version: 1,
  id,
  label,
  match: { url: `https://x.org/${id}` },
  elements: Object.fromEntries(
    Array.from({ length: elements }, (_, i) => [
      `e${i}`,
      { label: `E${i}`, kind: "control" as const, source: "recorded" as const, status: "accepted" as const, updatedAt: "" },
    ]),
  ),
});

const map: AppMap = {
  app: { version: 1, hosts: [] },
  screens: [screen("main", "Главная"), screen("login", "Вход"), screen("orphan", "Архив")],
};

it("names what appeared and what went", () => {
  const changed = compareDigest(["button:Войти", "textbox:Логин"], ["button:Войти", "textbox:Логин", "textbox:Код"]);

  // A new required field is the change that quietly breaks twelve scenarios.
  expect(changed.appeared).toEqual(["textbox:Код"]);
  expect(changed.gone).toEqual([]);

  expect(compareDigest(["button:Войти"], []).gone).toEqual(["button:Войти"]);
});

it("says which scenarios walk through a screen", () => {
  const usage = screenUsage([run("a.js", ["Главная", "Вход"]), run("b.js", ["Главная"])]);

  expect([...usage.get("Главная")!].sort()).toEqual(["a.js", "b.js"]);
  expect([...usage.get("Вход")!]).toEqual(["a.js"]);
});

it("finds the screen nothing tests", () => {
  const { nodes } = coverage(map, [run("a.js", ["Главная", "Вход"])]);

  // A screen in the map that no scenario reaches is a gap nobody would notice.
  expect(nodes.find((n) => n.id === "orphan")!.usedBy).toEqual([]);
  expect(nodes.find((n) => n.id === "main")!.usedBy).toEqual(["a.js"]);
});

it("records a move between screens, and who makes it", () => {
  const { edges } = coverage(map, [run("a.js", ["Главная", "Главная", "Вход"]), run("b.js", ["Главная", "Вход"])]);

  // Repeats within one screen are not moves.
  expect(edges).toHaveLength(1);
  expect(edges[0]).toMatchObject({ from: "main", to: "login", by: ["a.js", "b.js"] });
});

it("ignores steps that happened on no known screen", () => {
  const { edges } = coverage(map, [run("a.js", ["Главная", undefined, "Вход"])]);
  // The step in between says nothing about where it was; inventing a move
  // through it would report a path that nobody takes.
  expect(edges).toEqual([{ from: "main", to: "login", by: ["a.js"] }]);
});
