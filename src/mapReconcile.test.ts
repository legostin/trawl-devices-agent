import { expect, it } from "vitest";
import { reconcile, type Observation } from "./mapReconcile.js";
import type { AppMap } from "./mapTypes.js";

const NOW = "2026-07-27T09:00:00.000Z";

const emptyMap = (): AppMap => ({ app: { version: 1, hosts: [] }, screens: [] });

const observed = (over: Partial<Observation> = {}): Observation => ({
  screenId: "harakteristiki",
  screenLabel: "Характеристики",
  screenMatch: { url: "**/a/new/**" },
  label: "Подать объявление",
  kind: "control",
  targets: [{ role: "button", name: "Подать объявление" }],
  ...over,
});

it("creates the screen and the element on first sight", () => {
  const map = emptyMap();
  const outcome = reconcile(map, observed(), NOW);

  expect(outcome).toMatchObject({ created: true, ref: "Характеристики › Подать объявление" });
  expect(map.screens[0]!.id).toBe("harakteristiki");
  expect(map.screens[0]!.elements["podat-obyavlenie"]).toMatchObject({
    label: "Подать объявление",
    kind: "control",
    source: "recorded",
    status: "accepted",
  });
});

it("reuses the entry the second time and strengthens its ladder", () => {
  const map = emptyMap();
  reconcile(map, observed(), NOW);
  // The page gained a data-testid: the recorder now leads with it and keeps the
  // old role+name as a fallback, which is what identifies the entry.
  const outcome = reconcile(
    map,
    observed({ targets: [{ testId: "submit-advert" }, { role: "button", name: "Подать объявление" }] }),
    NOW,
  );

  expect(outcome).toMatchObject({ created: false, strengthened: true });
  expect(Object.keys(map.screens[0]!.elements)).toHaveLength(1);
  // The newly seen candidate becomes a fallback rather than replacing what works.
  expect(map.screens[0]!.elements["podat-obyavlenie"]!.target!.or).toContainEqual({ testId: "submit-advert" });
});

it("matches an existing entry by test id whatever it is called now", () => {
  const map = emptyMap();
  reconcile(map, observed({ targets: [{ testId: "submit-advert" }] }), NOW);
  const outcome = reconcile(map, observed({ label: "Отправить", targets: [{ testId: "submit-advert" }] }), NOW);

  expect(outcome.created).toBe(false);
  expect(Object.keys(map.screens[0]!.elements)).toHaveLength(1);
});

it("marks an element with no readable name for review", () => {
  const map = emptyMap();
  const outcome = reconcile(map, observed({ label: "", targets: [{ role: "button", nth: 12 }] }), NOW);

  expect(outcome.review).toMatch(/без названия/);
  expect(map.screens[0]!.elements[Object.keys(map.screens[0]!.elements)[0]!]!.status).toBe("proposed");
});

it("stores a choice with its group and option shape", () => {
  const map = emptyMap();
  reconcile(
    map,
    observed({ label: "Год", kind: "choice", targets: [{ css: "#years" }], option: { role: "radio" } }),
    NOW,
  );

  expect(map.screens[0]!.elements.god).toMatchObject({
    kind: "choice",
    group: { css: "#years" },
    option: { role: "radio" },
  });
});
