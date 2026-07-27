import type { Locator, Page } from "playwright";
import { AgentError } from "./types.js";
import { resolveTarget } from "./targets.js";
import type { ResolvedEntry } from "./mapResolve.js";

/** How many options to list back when the wanted one is missing. */
const MAX_LISTED_OPTIONS = 20;

/**
 * A map entry, plus a value for a `choice`, becomes a locator. The group is
 * located stably and the option is found by its own wording inside it — which
 * is what keeps a year out of the selector and in the value where it belongs.
 */
export async function locateEntry(
  page: Page,
  found: ResolvedEntry,
  value: string | undefined,
  probeMs: number,
): Promise<Locator> {
  const { entry } = found;
  const where = `${found.screen.label} › ${entry.label}`;

  if (entry.kind === "control") {
    if (!entry.target) throw new AgentError("script", `у элемента «${where}» нет локатора в карте`);
    return (await resolveTarget(page, entry.target, probeMs)).locator;
  }

  if (value === undefined) throw new AgentError("script", `для «${where}» нужно значение`);
  if (!entry.group) throw new AgentError("script", `у набора «${where}» нет группы в карте`);

  const group = (await resolveTarget(page, entry.group, probeMs)).locator;
  const role = entry.option?.role;
  const all = role ? group.getByRole(role as never) : group.getByRole("option");
  const option = role
    ? group.getByRole(role as never, { name: value })
    : group.getByText(value, { exact: false });

  if ((await option.count()) === 0) {
    const available = (
      await all.evaluateAll((nodes) =>
        nodes.map((node) => {
          const el = node as HTMLElement;
          const label =
            (el as HTMLInputElement).labels?.[0]?.textContent ?? el.getAttribute("aria-label") ?? el.textContent;
          return (label ?? "").replace(/\s+/g, " ").trim();
        }),
      )
    )
      .filter(Boolean)
      .slice(0, MAX_LISTED_OPTIONS);
    throw new AgentError(
      "script",
      `вариант «${value}» не найден в «${where}»` + (available.length ? `; есть: ${available.join(", ")}` : ""),
    );
  }
  return option.first();
}
