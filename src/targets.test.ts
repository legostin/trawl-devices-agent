import { expect, it, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toLocator, describeTarget } from "./targets.js";

const fixture = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/form.html"),
).href;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(fixture);
});
afterAll(async () => { await browser.close(); });

it("resolves every target kind to exactly one element", async () => {
  expect(await toLocator(page, { testId: "submit" }).count()).toBe(1);
  expect(await toLocator(page, { role: "button", name: "Войти" }).count()).toBe(1);
  expect(await toLocator(page, { label: "Email" }).count()).toBe(1);
  expect(await toLocator(page, { placeholder: "you@example.com" }).count()).toBe(1);
  expect(await toLocator(page, { text: "Sign in" }).count()).toBe(1);
  expect(await toLocator(page, { css: "#plan" }).count()).toBe(1);
});

it("applies within and nth", async () => {
  const rows = toLocator(page, { role: "row", within: { css: "#orders" } });
  expect(await rows.count()).toBe(2);
  const second = toLocator(page, { role: "row", name: "Заказ 42", within: { css: "#orders" } });
  expect(await second.textContent()).toBe("42");
  const byIndex = toLocator(page, { role: "row", within: { css: "#orders" }, nth: 0 });
  expect(await byIndex.textContent()).toBe("41");
});

it("accepts a RegExp and a transported regex spec", async () => {
  expect(await toLocator(page, { text: /Sign/ }).count()).toBe(1);
  expect(await toLocator(page, { text: { __regex: { source: "Sign", flags: "" } } }).count()).toBe(1);
});

it("rejects an empty target", () => {
  expect(() => toLocator(page, {})).toThrow(/empty target/);
});

it("describes a target for error messages", () => {
  expect(describeTarget({ role: "button", name: "Войти" })).toBe('role=button name="Войти"');
  expect(describeTarget({ testId: "submit", nth: 2 })).toBe("testId=submit [2]");
});
