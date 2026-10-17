import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { defaultCapabilities } from "../src/shared/config.ts";

const fixture = vi.hoisted(() => ({
  webSearch: {
    provider: "deepseek",
    enabled: false,
    hasApiKey: false,
    credentialsPersisted: false,
    credentialsLocked: false,
  },
  capabilities: { webSearch: true },
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({ settings: fixture }),
  unwrap: (value: unknown) => value,
}));

import { CapabilitySettings } from "../src/renderer/CapabilitySettings.tsx";
import { WebSearchSettings } from "../src/renderer/WebSearchSettings.tsx";

beforeEach(() => {
  fixture.webSearch = {
    provider: "deepseek",
    enabled: false,
    hasApiKey: false,
    credentialsPersisted: false,
    credentialsLocked: false,
  };
  fixture.capabilities = { ...defaultCapabilities };
});
const render = () => renderToStaticMarkup(createElement(WebSearchSettings));
const enableButton = (markup: string) =>
  markup.match(/<button[^>]*class="web-search-enable [^"]*"[^>]*>/)?.[0];

test("an unconfigured install requires a key before enabling and never claims unavailable encryption", () => {
  const markup = render();
  expect(markup).not.toContain("系统加密存储不可用");
  expect(markup).toContain("输入 DeepSeek API Key");
  expect(markup).toContain("尚未配置 API Key，联网服务不可用");
  expect(markup).toContain('type="password"');
  expect(markup).toContain('value=""');
  expect(markup).not.toContain("移除 API Key");
  expect(enableButton(markup)).toContain("disabled");
  expect(markup).toContain(">启用</button>");
  expect(markup).not.toContain("服务已启用");
});

test("only memory-only configured keys get the encryption warning", () => {
  fixture.webSearch.hasApiKey = true;
  expect(render()).toContain("系统加密存储不可用");
  expect(render()).toContain("移除 API Key");
  fixture.webSearch.credentialsPersisted = true;
  expect(render()).not.toContain("系统加密存储不可用");
  expect(render()).toContain("留空保留现有 API Key");
});

test("provider state is independent from the global web capability", () => {
  fixture.webSearch.hasApiKey = true;
  fixture.webSearch.credentialsPersisted = true;
  let markup = render();
  expect(enableButton(markup)).not.toContain("disabled");
  expect(markup).toContain("服务已停用");
  expect(markup).toContain(">启用</button>");
  fixture.webSearch.enabled = true;
  fixture.capabilities.webSearch = false;
  markup = render();
  expect(markup).toContain("服务已启用");
  expect(markup).toContain(">停用</button>");
  expect(markup).toContain("「插件能力」中的联网搜索已关闭");
  expect(enableButton(markup)).not.toContain("disabled");
});

test("locked stored keys get a distinct unavailable state and cannot be replaced or enabled", () => {
  fixture.webSearch.credentialsLocked = true;
  const markup = render();
  expect(markup).toContain("保存的 API Key 尚未解锁，联网服务暂不可用");
  expect(markup).not.toContain("尚未配置 API Key");
  expect(markup).not.toContain("系统加密存储不可用");
  expect(markup.match(/<input[^>]*id="web-search-api-key"[^>]*>/)?.[0]).toContain("disabled");
  expect(enableButton(markup)).toContain("disabled");
  fixture.webSearch.enabled = true;
  expect(render()).toContain(">停用</button>");
  expect(enableButton(render())).not.toContain("disabled");
});

test("settings exposes one provider card and credential field without a misleading selection state", () => {
  const markup = render();
  expect(markup.match(/class="web-search-provider-panel"/g)).toHaveLength(1);
  expect(markup).not.toContain('type="radio"');
  expect(markup).not.toContain('role="radiogroup"');
  expect(markup).not.toContain('aria-pressed="true"');
  expect(markup.match(/<input\b/g)).toHaveLength(1);
  expect(markup.match(/<input[^>]*type="password"[^>]*>/g)).toHaveLength(1);
  expect(markup).toContain("DeepSeek");
  expect(markup).toContain("返回的结果会发送给当前对话模型");
  expect(markup).toContain("不自动附带原始提问");
  expect(markup).toContain("不受当前对话模型服务商影响");
  expect(markup).not.toContain("Base URL");
});

test("the default-on web capability precedes subagents while model settings follow commands", () => {
  const markup = renderToStaticMarkup(createElement(CapabilitySettings));
  expect(markup.indexOf('aria-label="联网搜索"')).toBeLessThan(markup.indexOf('aria-label="子智能体"'));
  expect(markup.match(/<input[^>]*aria-label="联网搜索"[^>]*>/)?.[0]).toContain("checked");
  const page = readFileSync(new URL("../src/renderer/SettingsPage.tsx", import.meta.url), "utf8");
  const commands = page.indexOf('["commands", "命令", Terminal]');
  const models = page.indexOf('["models", "模型", Braces]');
  const capabilities = page.indexOf('["capabilities", "插件能力", Package]');
  expect(commands).toBeGreaterThan(-1);
  expect(models).toBeGreaterThan(commands);
  expect(models).toBeLessThan(capabilities);
  expect(page.match(/\["models", "模型", Braces\]/g)).toHaveLength(1);
  expect(page.indexOf('["webSearch", "联网搜索", Globe]')).toBeLessThan(
    page.indexOf('["subagents", "子智能体", Bot]'),
  );
  expect(page).toContain("<WebSearchSettings />");
});

test("primary button hover explicitly keeps foreground contrast", () => {
  const css = readFileSync(new URL("../src/renderer/web-search-settings.css", import.meta.url), "utf8");
  for (const selector of ["web-search-save", "web-search-enable\\.primary"]) {
    expect(css).toMatch(
      new RegExp(
        `\\.${selector}:hover:not\\(:disabled\\)\\s*\\{\\s*color: var\\(--color-on-primary\\);\\s*background:`,
      ),
    );
  }
});
