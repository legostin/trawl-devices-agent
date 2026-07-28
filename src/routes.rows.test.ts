import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRoutes } from "./routes.js";
import type { Route } from "./server.js";
import type { Row } from "./rows.js";

let root: string;
let routes: Route[];

const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
  const route = routes.find((r) => r.method === method && r.path === url)!;
  return route.handler({} as never, {}, body) as Promise<T>;
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rowsapi-"));
  routes = buildRoutes({ workspace: root });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("hands back rows for a scenario", async () => {
  const { rows } = await call<{ rows: Row[] }>("POST", "/scripts/rows", { code: "click('A')\n" });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.action).toBe("click");
});

it("applies a command and returns the new source", async () => {
  const code = "click('A')\nclick('B')\n";
  const { rows } = await call<{ rows: Row[] }>("POST", "/scripts/rows", { code });
  const result = await call<{ code: string }>("POST", "/scripts/apply", {
    code,
    command: { kind: "remove", id: rows[0]!.id },
  });
  expect(result.code).toBe("click('B')\n");
});

it("writes the extracted script to the workspace", async () => {
  const code = "step('Вход', () => {\n  click('A')\n})\nclick('B')\n";
  const result = await call<{ code: string; extracted: { path: string } }>("POST", "/scripts/apply", {
    code,
    command: { kind: "extract", section: "Вход" },
  });

  expect(result.extracted.path).toBe("scripts/vhod.js");
  expect(await readFile(path.join(root, "scripts/vhod.js"), "utf8")).toBe("click('A')\n");
  expect(result.code).toBe("run('scripts/vhod.js')\nclick('B')\n");
});
