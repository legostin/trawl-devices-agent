import { expect, it } from "vitest";
import { collapse, type CollapsedStep } from "./mapCollapse.js";

const group = { key: "year", label: "Год", targets: [{ css: "#years" }] };

it("turns picking an option into one select on its group", () => {
  const steps: CollapsedStep[] = [
    { ts: 1, action: "check", args: [{ role: "radio", name: "2010" }], group },
    { ts: 2, action: "click", args: [{ role: "button", name: "Подать объявление" }] },
  ];

  expect(collapse(steps)).toEqual([
    { ts: 1, action: "select", args: ["Год", "2010"], group },
    { ts: 2, action: "click", args: [{ role: "button", name: "Подать объявление" }] },
  ]);
});

it("keeps only the last answer to the same question", () => {
  const steps: CollapsedStep[] = [
    { ts: 1, action: "check", args: [{ role: "radio", name: "2009" }], group },
    { ts: 2, action: "check", args: [{ role: "radio", name: "2010" }], group },
  ];

  // Changing your mind while recording is not two steps of the scenario.
  expect(collapse(steps)).toEqual([{ ts: 2, action: "select", args: ["Год", "2010"], group }]);
});

it("does not merge across an unrelated step", () => {
  const gear = { key: "gear", label: "Коробка", targets: [{ css: "#gears" }] };
  const steps: CollapsedStep[] = [
    { ts: 1, action: "check", args: [{ role: "radio", name: "2010" }], group },
    { ts: 2, action: "check", args: [{ role: "radio", name: "Робот" }], group: gear },
    { ts: 3, action: "check", args: [{ role: "radio", name: "2011" }], group },
  ];

  expect(collapse(steps).map((s) => s.args)).toEqual([
    ["Год", "2010"],
    ["Коробка", "Робот"],
    ["Год", "2011"],
  ]);
});

it("leaves an option with no readable name alone", () => {
  const steps: CollapsedStep[] = [{ ts: 1, action: "check", args: [{ role: "radio", nth: 3 }], group }];
  expect(collapse(steps)).toEqual(steps);
});

it("carries the fields the caller hung on the step", () => {
  const steps: CollapsedStep[] = [
    { ts: 1, action: "check", args: [{ role: "radio", name: "2010" }], group, url: "https://x.org/a/new/" },
  ];
  // The url is what the recording is cut into sections on; losing it here would
  // silently put the step on the wrong screen.
  expect(collapse(steps)[0]!.url).toBe("https://x.org/a/new/");
});
