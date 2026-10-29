import { expect, it } from "vitest";
import { responsesProxyUrl } from "../src/main/responses-proxy.ts";

it.each([
  ["DIRECT", undefined],
  ["PROXY 127.0.0.1:7890; DIRECT", "http://127.0.0.1:7890"],
  ["HTTPS proxy.example:443", "https://proxy.example:443"],
  ["SOCKS5 127.0.0.1:1080", "socks5h://127.0.0.1:1080"],
  ["SOCKS proxy.example:1080", "socks4a://proxy.example:1080"],
])("uses Chromium's resolved route %s", (rules, expected) => {
  expect(responsesProxyUrl(rules)).toBe(expected);
});

it("fails closed on unsupported proxy settings so the request can fall back to Chromium HTTP", () => {
  expect(() => responsesProxyUrl("unknown proxy")).toThrow("Unsupported");
});
