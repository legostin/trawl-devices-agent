import { expect, it } from "vitest";
import { domainOf } from "./mapDomain.js";

it("keeps the halves of one product together", () => {
  // The login lives on its own host; splitting by host would put a flow's two
  // halves in two maps.
  expect(domainOf("https://desktop-main-kl.example-team.org/")).toBe("example-team.org");
  expect(domainOf("https://main-id.example-team.org/login/")).toBe("example-team.org");
});

it("keeps different products apart", () => {
  expect(domainOf("https://shop.example.org/")).not.toBe(domainOf("https://other.test/"));
});

it("handles a compound public suffix", () => {
  expect(domainOf("https://www.shop.example.co.uk/a")).toBe("example.co.uk");
});

it("answers for a bare host, an address and localhost", () => {
  expect(domainOf("https://example.org/")).toBe("example.org");
  expect(domainOf("http://127.0.0.1:8080/x")).toBe("127.0.0.1");
  expect(domainOf("http://localhost:3000/")).toBe("localhost");
});

it("reads a host out of a pattern, not just a url", () => {
  expect(domainOf("https://auto.example.org/a/new/*")).toBe("example.org");
  // Patterns from early recordings name no host at all.
  expect(domainOf("**/login/")).toBe("local");
});
