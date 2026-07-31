import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RecorderStore } from "./recorder.js";
import { SessionStore } from "./sessions.js";
import { Runner } from "./runner.js";
import { validateDevice } from "./devices.js";
import { MapStore } from "./mapStore.js";
import type { RunReport } from "./types.js";

const fixture = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/form.html"),
).href;

const device = validateDevice({ id: "t", name: "T", headless: true, proxy: { mode: "none" }, trace: "off" });
let sessions: SessionStore;
let recorder: RecorderStore;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rec-"));
  sessions = new SessionStore();
  recorder = new RecorderStore({ sessions, workspace: root });
});
afterEach(async () => {
  await sessions.stopAll();
  await rm(root, { recursive: true, force: true });
});

it("records clicks and typing as declarative steps", async () => {
  const session = await sessions.start(device, { headless: true });
  const recording = await recorder.start(session.sessionId, fixture);

  const page = sessions.get(session.sessionId).page;
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByTestId("submit").click();
  await page.waitForTimeout(300);

  const result = await recorder.stop(recording.id, {});
  const actions = result.steps.map((s) => s.action);
  expect(actions).toContain("fill");
  expect(actions).toContain("click");

  // The script says what it means; the ladder lives in the map.
  const fillStep = result.steps.find((s) => s.action === "fill")!;
  expect(fillStep.args[0]).toBe("Email");
  expect(fillStep.args[1]).toBe("user@example.com");

  const clickStep = result.steps.find((s) => s.action === "click")!;
  expect(clickStep.args[0]).toBe("Войти");
  expect(result.warnings).toEqual([]);

  // The ladder prefers role+name over label, and testId over everything; the
  // runners-up are kept as fallbacks for when a refactor breaks the primary.
  const map = await new MapStore(root).load();
  const elements = map.screens[0]!.elements;
  const email = Object.values(elements).find((e) => e.label === "Email")!.target!;
  expect(email).toMatchObject({ role: "textbox", name: "Email" });
  expect(email.or).toContainEqual({ label: "Email" });

  const submit = Object.values(elements).find((e) => e.label === "Войти")!.target!;
  expect(submit).toMatchObject({ testId: "submit" });
  expect(submit.or).toContainEqual({ role: "button", name: "Войти" });
});

it("round-trips: recorded clicks replay green", async () => {
  const session = await sessions.start(device, { headless: true });
  const recording = await recorder.start(session.sessionId, fixture);
  const page = sessions.get(session.sessionId).page;
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByTestId("submit").click();
  await page.waitForTimeout(300);
  const result = await recorder.stop(recording.id, { saveAs: "scripts/recorded.js" });

  expect(await readFile(path.join(root, "scripts/recorded.js"), "utf8")).toBe(result.code);

  const runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });
  const started = await runner.start({
    code: `goto('${fixture}')\n` + result.code,
    device,
    env: {},
    secrets: {},
  });
  let report: RunReport = runner.get(started.runId)!;
  for (let i = 0; i < 300 && report.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    report = runner.get(started.runId)!;
  }
  expect(report.steps.find((s) => s.status === "failed")?.error).toBeUndefined();
  expect(report.status).toBe("passed");
});

it("records addresses the human opens, but not navigation caused by a recorded click", async () => {
  const session = await sessions.start(device, { headless: true });
  const recording = await recorder.start(session.sessionId);
  const page = sessions.get(session.sessionId).page;

  // Typed into the address bar: nothing preceded it, so it is a step.
  const index = fixture.replace("form.html", "index.html");
  await page.goto(index);
  await page.waitForTimeout(200);

  // Clicking the link is recorded; the navigation it causes must not add a goto.
  await page.getByRole("link", { name: "Open the form" }).click();
  await page.waitForTimeout(600);

  const result = await recorder.stop(recording.id, {});
  const actions = result.steps.map((s) => s.action);

  expect(actions[0]).toBe("goto");
  expect(result.steps[0]!.args[0]).toBe(index);
  expect(actions).toContain("click");
  expect(actions.filter((a) => a === "goto")).toHaveLength(1);
});

it("a recording that starts from a typed address replays on its own", async () => {
  const session = await sessions.start(device, { headless: true });
  const recording = await recorder.start(session.sessionId);
  const page = sessions.get(session.sessionId).page;

  await page.goto(fixture);
  await page.waitForTimeout(200);
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByTestId("submit").click();
  await page.waitForTimeout(300);
  const result = await recorder.stop(recording.id, {});

  // No hand-written goto prefix this time — the script must carry its own.
  const runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });
  const started = await runner.start({ code: result.code, device, env: {}, secrets: {} });
  let report: RunReport = runner.get(started.runId)!;
  for (let i = 0; i < 300 && report.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    report = runner.get(started.runId)!;
  }
  expect(report.steps[0]!.action).toBe("goto");
  expect(report.status).toBe("passed");
});

it("never records a target that would hit several elements on replay", async () => {
  const session = await sessions.start(device, { headless: true });
  const list = fixture.replace("form.html", "list.html");
  const recording = await recorder.start(session.sessionId, list);
  const page = sessions.get(session.sessionId).page;

  // The link whose text carries newlines and double spaces — the case that made
  // the accessible name miss and dropped the recorder onto a css path matching
  // every link on the page.
  await page.getByRole("link", { name: "Вход и регистрация" }).click();
  await page.waitForTimeout(300);
  const result = await recorder.stop(recording.id, {});

  const map = await new MapStore(root).load();
  const entry = Object.values(map.screens[0]!.elements)[0]!;

  // Whatever the recorder chose, it must resolve to exactly one element.
  const check = await sessions.start(device, { headless: true });
  const probe = sessions.get(check.sessionId).page;
  await probe.goto(list);
  const { toLocator } = await import("./targets.js");
  expect(await toLocator(probe, entry.target!).count()).toBe(1);
  expect(String(entry.target!.name ?? "")).not.toContain("\n");
});

it("prefers wording without digits, and matches by position when the text is data", async () => {
  const session = await sessions.start(device, { headless: true });
  const orders = fixture.replace("form.html", "orders.html");
  const recording = await recorder.start(session.sessionId, orders);
  const page = sessions.get(session.sessionId).page;

  // Stable wording: the button keeps its name whatever the data does.
  await page.getByRole("button", { name: "Создать заказ" }).click();
  await page.waitForTimeout(200);
  // Data: "Заказ 42 — 9 900 ₸" is this week's number, not a selector.
  await page.getByRole("link", { name: /Заказ 42/ }).click();
  await page.waitForTimeout(300);

  const result = await recorder.stop(recording.id, {});
  const clicks = result.steps.filter((s) => s.action === "click");
  const [button, order] = clicks.map((s) => s.args[0] as string);

  // Stable wording names the entry; data wording names nothing, so that entry
  // is stored unnamed and surfaces for review instead of pretending.
  expect(button).toBe("Создать заказ");
  expect(order).toBe("Без названия (link)");
  expect(result.map.review).toHaveLength(1);

  // And the locator must not be pinned to today's number — not even as a fallback.
  const map = await new MapStore(root).load();
  const entry = Object.values(map.screens[0]!.elements).find((e) => e.label.startsWith("Без названия"))!;
  expect(JSON.stringify(entry.target)).not.toContain("42");
  expect(entry.target).toMatchObject({ role: "link", nth: 1 });
  expect(entry.status).toBe("proposed");
  expect(result.warnings.some((w) => w.includes("matched by position"))).toBe(true);
});

it("records a navigating click before the navigation it causes, with a real target", async () => {
  // The exact shape that broke on kolesa.kz: a header link that leaves the page.
  const session = await sessions.start(device, { headless: true });
  const index = fixture.replace("form.html", "index.html");
  const recording = await recorder.start(session.sessionId, index);
  const page = sessions.get(session.sessionId).page;

  await page.getByRole("link", { name: "Open the form" }).click();
  await page.waitForTimeout(600);
  const result = await recorder.stop(recording.id, {});

  const actions = result.steps.map((s) => s.action);
  const clickAt = actions.indexOf("click");
  expect(clickAt).toBeGreaterThanOrEqual(0);

  // The click must come before any goto that follows it — otherwise the replay
  // opens the destination and then hunts for the link that took it there.
  const gotoAfter = actions.slice(clickAt + 1).includes("goto");
  const gotoBefore = actions.slice(0, clickAt).lastIndexOf("goto");
  expect(gotoBefore).toBeLessThan(clickAt);
  expect(gotoAfter).toBe(false);

  // And the entry behind it is a real locator, not a css path scraped after the fact.
  expect(result.steps[clickAt]!.args[0]).toBe("Open the form");
  const map = await new MapStore(root).load();
  const entry = Object.values(map.screens[0]!.elements)[0]!;
  expect(entry.target).toMatchObject({ role: "link", name: "Open the form" });
  expect(entry.target!.css).toBeUndefined();
});

it("records a fragment of a session in progress, without reloading it", async () => {
  const session = await sessions.start(device, { headless: true });
  const page = sessions.get(session.sessionId).page;

  // Get somewhere first — the state a fragment recording must not lose.
  await page.goto(fixture);
  await page.getByLabel("Email").fill("already@typed.in");

  const recording = await recorder.start(session.sessionId);
  expect(await page.getByLabel("Email").inputValue()).toBe("already@typed.in");

  await page.getByTestId("submit").click();
  await page.waitForTimeout(300);
  const result = await recorder.stop(recording.id, {});

  // Only what happened after the recording started.
  expect(result.steps.map((s) => s.action)).toEqual(["click"]);
});

it("records again in a session that has already been recorded once", async () => {
  const session = await sessions.start(device, { headless: true });
  const page = sessions.get(session.sessionId).page;

  const first = await recorder.start(session.sessionId, fixture);
  await page.getByTestId("submit").click();
  await page.waitForTimeout(300);
  const one = await recorder.stop(first.id, {});
  expect(one.steps.map((s) => s.action)).toContain("click");

  // The second recording in the same browser — the case that produced a file
  // with nothing but the header comment in it.
  const second = await recorder.start(session.sessionId);
  await page.getByLabel("Email").fill("second@example.com");
  await page.getByTestId("submit").click();
  await page.waitForTimeout(400);
  const two = await recorder.stop(second.id, {});

  expect(two.steps.map((s) => s.action)).toEqual(["fill", "click"]);
  expect(two.code).toContain("second@example.com");
});

const controls = fixture.replace("form.html", "controls.html");

/** Run a recording against the controls fixture and hand back its steps. */
async function recordControls(act: (page: import("playwright").Page) => Promise<void>) {
  const session = await sessions.start(device, { headless: true });
  const recording = await recorder.start(session.sessionId, controls);
  const page = sessions.get(session.sessionId).page;
  await act(page);
  await page.waitForTimeout(300);
  return recorder.stop(recording.id, {});
}

it("records the button, not the icon inside it", async () => {
  const result = await recordControls(async (page) => {
    await page.locator("#icon-glyph").click();
  });

  const click = result.steps.find((s) => s.action === "click")!;
  expect(click.args[0]).toBe("Настройки");

  // The css path of the svg must not survive anywhere — not even in the map.
  const map = await new MapStore(root).load();
  const entry = Object.values(map.screens[0]!.elements)[0]!;
  expect(entry.target).toMatchObject({ role: "button", name: "Настройки" });
  expect(JSON.stringify(entry.target)).not.toContain("svg");
});

it("records a checkbox toggled through its label exactly once", async () => {
  const result = await recordControls(async (page) => {
    await page.locator("#agree-text").click();
  });

  // Label activation makes the browser click the control too; recording both
  // would toggle it twice on replay.
  expect(result.steps.map((s) => s.action)).toEqual(["goto", "check"]);
});

it("never records a fill for a radio or a checkbox", async () => {
  const result = await recordControls(async (page) => {
    await page.getByRole("radio", { name: "2010" }).click();
  });

  // Picking one of a fixed set is a select on the group, not a check on the
  // seventh radio — and never a fill with the option's value attribute.
  expect(result.steps.map((s) => s.action)).not.toContain("fill");
  expect(result.steps.map((s) => s.action)).toEqual(["goto", "select"]);
});

it("names a radio by its own label even when that label is a number", async () => {
  const result = await recordControls(async (page) => {
    await page.getByRole("radio", { name: "2010" }).click();
  });

  // "2010" is the identity of an option, not this week's data — the case that
  // used to produce check({ role: 'radio', nth: 7 }). It ends up as the value.
  const step = result.steps.find((s) => s.action === "select")!;
  expect(step.args).toEqual(["Год", "2010"]);

  const map = await new MapStore(root).load();
  const entry = Object.values(map.screens[0]!.elements).find((e) => e.label === "Год")!;
  expect(entry.kind).toBe("choice");
  expect(JSON.stringify(entry.group)).not.toContain("nth");
});

it("names a button by its title when it has nothing else", async () => {
  const result = await recordControls(async (page) => {
    await page.locator("#titled-glyph").click();
  });

  const click = result.steps.find((s) => s.action === "click")!;
  expect(click.args[0]).toBe("Добавить фото");
});

it("pauses without ending the recording, and picks up where it left off", async () => {
  const session = await sessions.start(device, { headless: true });
  const recording = await recorder.start(session.sessionId, controls);
  const page = sessions.get(session.sessionId).page;

  await page.locator("#icon-glyph").click();
  await page.waitForTimeout(200);

  expect(await recorder.setPaused(recording.id, true)).toEqual({ paused: true });
  // A detour, a captcha, fixing a typo — none of it belongs in the scenario.
  await page.locator("#titled-glyph").click();
  await page.waitForTimeout(200);

  expect(await recorder.setPaused(recording.id, false)).toEqual({ paused: false });
  await page.locator("#agree-text").click();
  await page.waitForTimeout(200);

  const result = await recorder.stop(recording.id, {});
  expect(result.steps.map((s) => s.action)).toEqual(["goto", "click", "check"]);
  expect(JSON.stringify(result.steps)).not.toContain("Добавить фото");
});

it("files a modal as a screen of its own, not as part of the page under it", async () => {
  const session = await sessions.start(device, { headless: true });
  const dialog = fixture.replace("form.html", "dialog.html");
  const recording = await recorder.start(session.sessionId, dialog);
  const page = sessions.get(session.sessionId).page;

  await page.getByRole("button", { name: "Войти" }).click();
  await page.getByLabel("Телефон").fill("747");
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.waitForTimeout(300);
  await recorder.stop(recording.id, {});

  // A modal shares its url with the page beneath, so without treating it as a
  // screen everything it owns is filed under whatever page it opened on.
  const map = await new MapStore(root).load();
  const screens = Object.fromEntries(
    map.screens.map((s) => [s.label, Object.values(s.elements).map((e) => e.label).sort()]),
  );
  expect(screens["Вход в личный кабинет"]).toEqual(["Продолжить", "Телефон"]);
  expect(screens["dialog fixture"]).toEqual(["Войти"]);
});
