import type { ConsoleMessage, Page } from "playwright";
import { AgentError, type TargetSpec } from "./types.js";
import { toLocator } from "./targets.js";

export interface SnapshotNode {
  ref: string;
  role: string;
  name: string;
  label?: string;
  tag: string;
  value?: string;
  visible: boolean;
}

export interface ActionInput {
  action: "click" | "fill" | "check" | "uncheck" | "select" | "hover" | "press" | "goto" | "screenshot";
  ref?: string;
  target?: TargetSpec;
  value?: string;
}

export interface ActionDelta {
  url: string;
  title: string;
  consoleErrors: string[];
}

const REF_ATTR = "data-trawl-ref";

/** Interactive/labelled nodes, each tagged with a stable ref for the next action. */
export async function snapshot(page: Page): Promise<SnapshotNode[]> {
  return page.evaluate((refAttr) => {
    const SELECTOR =
      "a[href],button,input,select,textarea,[role],[tabindex]:not([tabindex='-1']),h1,h2,h3,label";
    const implicitRole = (el: Element): string => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "label") return "label";
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "input") {
        const type = (el.getAttribute("type") ?? "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button") return "button";
        return "textbox";
      }
      return tag;
    };

    let counter = 0;
    const out: SnapshotNodeLike[] = [];
    interface SnapshotNodeLike {
      ref: string;
      role: string;
      name: string;
      label?: string;
      tag: string;
      value?: string;
      visible: boolean;
    }

    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      const ref = `e${++counter}`;
      el.setAttribute(refAttr, ref);
      const input = el as HTMLInputElement;
      const labelled = input.labels?.[0]?.textContent?.trim();
      const rect = el.getBoundingClientRect();
      out.push({
        ref,
        role: implicitRole(el),
        name: (el.getAttribute("aria-label") ?? labelled ?? el.textContent ?? "").trim().slice(0, 80),
        ...(labelled ? { label: labelled } : {}),
        tag: el.tagName.toLowerCase(),
        ...(input.value !== undefined ? { value: String(input.value).slice(0, 80) } : {}),
        visible: rect.width > 0 && rect.height > 0,
      });
    }
    return out;
  }, REF_ATTR);
}

/** Perform one action by ref or by declarative target, and report what changed. */
export async function performAction(page: Page, input: ActionInput): Promise<ActionDelta> {
  const consoleErrors: string[] = [];
  const onConsole = (msg: ConsoleMessage): void => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  };
  page.on("console", onConsole);

  try {
    if (input.action === "goto") {
      await page.goto(input.value ?? "about:blank");
    } else if (input.action !== "screenshot") {
      const locator = input.ref ? page.locator(`[${REF_ATTR}="${input.ref}"]`) : toLocator(page, input.target ?? {});
      if (input.ref && (await locator.count()) === 0) {
        throw new AgentError("script", `unknown ref: ${input.ref}`);
      }
      switch (input.action) {
        case "click":
          await locator.click({ timeout: 10_000 });
          break;
        case "fill":
          await locator.fill(input.value ?? "", { timeout: 10_000 });
          break;
        case "check":
          await locator.check({ timeout: 10_000 });
          break;
        case "uncheck":
          await locator.uncheck({ timeout: 10_000 });
          break;
        case "select":
          await locator.selectOption(input.value ?? "", { timeout: 10_000 });
          break;
        case "hover":
          await locator.hover({ timeout: 10_000 });
          break;
        case "press":
          await locator.press(input.value ?? "Enter", { timeout: 10_000 });
          break;
      }
    }
    await page.waitForTimeout(150);
    return { url: page.url(), title: await page.title(), consoleErrors };
  } finally {
    page.off("console", onConsole);
  }
}
