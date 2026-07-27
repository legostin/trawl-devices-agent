import { expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { locateEntry } from "./mapLocate.js";
import type { ElementEntry, ScreenFile } from "./mapTypes.js";

const choices = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/choices.html"),
).href;

let browser: Browser;
let page: Page;
beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(choices);
});
afterEach(async () => {
  await browser.close();
});

const screen: ScreenFile = { version: 1, id: "s", label: "Характеристики", match: { url: "**" }, elements: {} };
const found = (entry: ElementEntry) => ({ screen, key: "k", entry });

const god: ElementEntry = {
  label: "Год",
  kind: "choice",
  group: { role: "group", name: "Год", or: [{ css: "#years" }] },
  option: { role: "radio" },
  source: "recorded",
  status: "accepted",
  updatedAt: "2026-07-27T09:00:00.000Z",
};

it("finds the option by its own text inside the group", async () => {
  const locator = await locateEntry(page, found(god), "2010", 1000);
  expect(await locator.count()).toBe(1);
  expect(await locator.getAttribute("value")).toBe("2010");
});

it("says which options exist when the wanted one does not", async () => {
  await expect(locateEntry(page, found(god), "1999", 1000)).rejects.toThrow(/2009, 2010, 2011/);
});

it("scopes the option to its own group", async () => {
  const gear: ElementEntry = { ...god, label: "Коробка", group: { css: "#gears" } };
  const locator = await locateEntry(page, found(gear), "Робот", 1000);
  expect(await locator.getAttribute("value")).toBe("robot");
});

it("locates a control without a value", async () => {
  const control: ElementEntry = {
    label: "Подать объявление",
    kind: "control",
    target: { role: "button", name: "Подать объявление" },
    source: "recorded",
    status: "accepted",
    updatedAt: "2026-07-27T09:00:00.000Z",
  };
  const locator = await locateEntry(page, found(control), undefined, 1000);
  expect(await locator.count()).toBe(1);
});

it("refuses a choice without a value", async () => {
  await expect(locateEntry(page, found(god), undefined, 1000)).rejects.toThrow(/нужно значение/);
});
