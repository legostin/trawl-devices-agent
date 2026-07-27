import { expect, it } from "vitest";
import { bindingsFor, templatePath } from "./mapApi.js";

it("templates ids out of a path", () => {
  expect(templatePath("https://x.org/api/adverts/87031015")).toBe("/api/adverts/:id");
  expect(templatePath("https://x.org/a/confirm/c0369630-d1e2-49e2-b4f9-a25bae8ba3fc/")).toBe("/a/confirm/:id");
  expect(templatePath("https://x.org/api/car/models?brand=vw")).toBe("/api/car/models");
});

it("proposes one binding per method and templated path", () => {
  const flows = [
    { method: "POST", url: "https://app.example.org/api/adverts", status: 201 },
    { method: "GET", url: "https://app.example.org/api/adverts/1", status: 200 },
    { method: "GET", url: "https://app.example.org/api/adverts/2", status: 200 },
    { method: "GET", url: "https://cdn.other.org/img/1.png", status: 200 },
  ];

  // Third-party hosts are not the application; static assets are not intent.
  expect(bindingsFor(flows, ["app.example.org"])).toEqual(["POST /api/adverts", "GET /api/adverts/:id"]);
});

it("ignores a request that never got a response", () => {
  const flows = [{ method: "GET", url: "https://app.example.org/api/ping", status: null }];
  expect(bindingsFor(flows, ["app.example.org"])).toEqual([]);
});
