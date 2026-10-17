import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { defaultCapabilities } from "../src/shared/config.ts";

const fixture = vi.hoisted(() => ({
  webSearch: { provider: "deepseek", hasApiKey: false, credentialsPersisted: false },
  capabilities: {},
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({ settings: fixture }),
  unwrap: (value: unknown) => value,
}));

import { CapabilitySettings } from "../src/renderer/CapabilitySettings.tsx";
import { WebSearchSettings } from "../src/renderer/WebSearchSettings.tsx";

beforeEach(() => {
  fixture.webSearch = { provider: "deepseek", hasApiKey: false, credentialsPersisted: false };
  fixture.capabilities = { ...defaultCapabilities };
});
const render = () => renderToStaticMarkup(createElement(WebSearchSettings));

test("an unconfigured new install does not claim encryption is unavailable", () => {
  const markup = render();
  expect(markup).not.toContain("系统加密存储不可用");
  expect(markup).toContain("输入 DeepSeek API Key");
  expect(markup).toContain('type="password"');
  expect(markup).toContain('value=""');
  expect(markup).not.toContain("移除 API Key");
});

test("only memory-only configured keys get the encryption warning", () => {
  fixture.webSearch.hasApiKey = true;
  expect(render()).toContain("系统加密存储不可用");
  expect(render()).toContain("移除 API Key");
  fixture.webSearch.credentialsPersisted = true;
  expect(render()).not.toContain("系统加密存储不可用");
  expect(render()).toContain("留空保留现有 API Key");
});

test("settings exposes one provider and one credential field with data-routing disclosure", () => {
  const markup = render();
  expect(markup).toContain("DeepSeek");
  expect(markup.match(/<input\b/g)).toHaveLength(1);
  expect(markup).toContain("返回的结果会发送给当前对话模型");
  expect(markup).toContain("不自动附带原始提问");
  expect(markup).toContain("不受当前对话模型服务商影响");
  expect(markup).not.toContain("Base URL");
});

test("the off-by-default web switch precedes subagents and has an independent navigation item", () => {
  const markup = renderToStaticMarkup(createElement(CapabilitySettings));
  expect(markup.indexOf('aria-label="联网搜索"')).toBeLessThan(markup.indexOf('aria-label="子智能体"'));
  expect(markup).toMatch(/aria-label="联网搜索"[^>]*\/>/);
  expect(markup.match(/<input[^>]*aria-label="联网搜索"[^>]*>/)?.[0]).not.toContain("checked");
  const page = readFileSync(new URL("../src/renderer/SettingsPage.tsx", import.meta.url), "utf8");
  expect(page.indexOf('["webSearch", "联网搜索", Globe]')).toBeLessThan(
    page.indexOf('["subagents", "子智能体", Bot]'),
  );
  expect(page).toContain("<WebSearchSettings />");
});

test("primary button hover explicitly keeps foreground contrast", () => {
  const css = readFileSync(new URL("../src/renderer/web-search-settings.css", import.meta.url), "utf8");
  expect(css).toMatch(
    /\.web-search-save:hover:not\(:disabled\)\s*\{\s*color: var\(--color-on-primary\);\s*background:/,
  );
});
