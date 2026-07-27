import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RecorderStore } from "./recorder.js";
import { SessionStore } from "./sessions.js";
import { Runner } from "./runner.js";
import { validateDevice } from "./devices.js";
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

  // The ladder prefers role+name over label, and testId over everything; the
  // runners-up are kept as fallbacks for when a refactor breaks the primary.
  const fillStep = result.steps.find((s) => s.action === "fill")!;
  expect(fillStep.args[0]).toMatchObject({ role: "textbox", name: "Email" });
  expect((fillStep.args[0] as { or?: unknown[] }).or).toContainEqual({ label: "Email" });
  expect(fillStep.args[1]).toBe("user@example.com");

  const clickStep = result.steps.find((s) => s.action === "click")!;
  expect(clickStep.args[0]).toMatchObject({ testId: "submit" });
  expect((clickStep.args[0] as { or?: unknown[] }).or).toContainEqual({ role: "button", name: "Войти" });
  expect(result.warnings).toEqual([]);
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

  const click = result.steps.find((s) => s.action === "click")!;
  const target = click.args[0] as Record<string, unknown>;

  // Whatever the recorder chose, it must resolve to exactly one element.
  const check = await sessions.start(device, { headless: true });
  const probe = sessions.get(check.sessionId).page;
  await probe.goto(list);
  const { toLocator } = await import("./targets.js");
  expect(await toLocator(probe, target).count()).toBe(1);
  expect(target.name ?? "").not.toContain("\n");
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
  const [button, order] = clicks.map((s) => s.args[0] as Record<string, unknown>);

  expect(button).toMatchObject({ role: "button", name: "Создать заказ" });

  // The order link must not be pinned to today's number — not even as a fallback.
  expect(JSON.stringify(order)).not.toContain("42");
  expect(order).toMatchObject({ role: "link", nth: 1 });
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

  // And the target is a real locator, not a css path scraped after the fact.
  const target = result.steps[clickAt]!.args[0] as Record<string, unknown>;
  expect(target).toMatchObject({ role: "link", name: "Open the form" });
  expect(target.css).toBeUndefined();
});
