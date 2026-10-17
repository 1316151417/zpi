import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defaultCapabilities } from "../src/shared/config.ts";

const fixture = vi.hoisted(() => ({
  webSearch: {
    provider: "deepseek",
    enabled: false,
    hasApiKey: false,
    apiKeyLength: 0,
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
    apiKeyLength: 0,
    credentialsPersisted: false,
    credentialsLocked: false,
  };
  fixture.capabilities = { ...defaultCapabilities };
});
afterEach(() => vi.unstubAllGlobals());
const render = () => renderToStaticMarkup(createElement(WebSearchSettings));
const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const keyInput = (markup: string) => markup.match(/<input[^>]*id="web-search-api-key"[^>]*>/)?.[0];
const toggle = (markup: string) => markup.match(/<input[^>]*role="switch"[^>]*>/)?.[0];

test("unconfigured settings cannot enable and do not claim encryption failure", () => {
  const markup = render();
  expect(markup).not.toContain("系统加密存储不可用");
  expect(keyInput(markup)).toContain('type="password"');
  expect(keyInput(markup)).toContain('value=""');
  expect(toggle(markup)).toContain("disabled");
  expect(markup).not.toContain("provider-more");
});
test("saved keys use derived length only, with an enabled eye and no automatic read", () => {
  fixture.webSearch.hasApiKey = true;
  fixture.webSearch.apiKeyLength = 56;
  fixture.webSearch.credentialsPersisted = true;
  const reveal = vi.fn();
  vi.stubGlobal("window", { zpi: { getWebSearchCredentials: reveal } });
  const markup = render();
  expect(keyInput(markup)).toContain(`value="${"*".repeat(56)}"`);
  expect(keyInput(markup)).toContain('type="password"');
  expect(markup.match(/<button[^>]*aria-label="显示 API Key"[^>]*>/)?.[0]).not.toContain("disabled");
  expect(markup).toContain("provider-more");
  expect(markup).not.toContain("点击眼睛查看已保存");
  expect(reveal).not.toHaveBeenCalled();
});
test("memory-only and locked states are honest; no guessed length for locked credentials", () => {
  fixture.webSearch.hasApiKey = true;
  expect(render()).toContain("系统加密存储不可用");
  fixture.webSearch.hasApiKey = false;
  fixture.webSearch.credentialsLocked = true;
  const markup = render();
  expect(markup).toContain("保存的 API Key 尚未解锁");
  expect(markup).not.toContain("系统加密存储不可用");
  expect(keyInput(markup)).toContain('value=""');
  expect(keyInput(markup)).toContain("disabled");
  expect(toggle(markup)).toContain("disabled");
  fixture.webSearch.enabled = true;
  expect(toggle(render())).not.toContain("disabled");
});
test("provider and global switches remain independent with one credential field", () => {
  fixture.webSearch.hasApiKey = true;
  fixture.webSearch.enabled = true;
  fixture.capabilities.webSearch = false;
  const markup = render();
  expect(toggle(markup)).toContain('aria-checked="true"');
  expect(toggle(markup)).not.toContain("disabled");
  expect(markup).toContain("「插件能力」中的联网搜索已关闭");
  expect(markup.match(/type="password"/g)).toHaveLength(1);
  expect(markup).not.toContain('type="radio"');
  expect(markup).not.toContain("Base URL");
  expect(markup).not.toContain("独立配置联网服务");
  expect(markup).not.toContain("返回的结果会发送给当前对话模型");
  expect(markup).not.toContain("不自动附带原始提问");
  expect(markup).not.toContain("DeepSeek 服务已启用。");
});
test("both settings editors render shared credential/header controls without web control CSS", () => {
  const model = source("../src/renderer/SettingsPage.tsx");
  const web = source("../src/renderer/WebSearchSettings.tsx");
  for (const component of ["ProviderCredentialInput", "ProviderHeadingActions"]) {
    expect(model).toContain(`<${component}`);
    expect(web).toContain(`<${component}`);
  }
  const markup = render();
  expect(markup).toContain("provider-enabled-switch");
  expect(markup).toContain("credential-input");
  const heading = markup.match(/<header class="provider-detail-heading">[\s\S]*?<\/header>/)?.[0];
  expect(heading?.match(/<img[^>]*class="provider-logo"[^>]*>/)?.[0]).toMatch(/width="20" height="20"/);
  expect(markup.match(/<svg[^>]*class="[^"]*lucide-eye[^"]*"[^>]*>/)?.[0]).toMatch(/width="14" height="14"/);
  const css = source("../src/renderer/web-search-settings.css");
  expect(css).not.toMatch(/secondary|primary|button|credential-input|provider-heading-actions|:hover/);
  expect(web).not.toContain("web-search-remove");
  expect(web).not.toContain("web-search-enable");
});

test("the compact model-style layout lists only DeepSeek beside the existing editor", () => {
  const markup = render();
  expect(markup).toContain('class="settings-layout model-provider-panel web-search-provider-panel"');
  const navigation = markup.match(/<nav class="provider-list"[\s\S]*?<\/nav>/)?.[0];
  expect(navigation).toContain('aria-label="联网搜索提供商"');
  expect(navigation?.match(/<button\b/g)).toHaveLength(1);
  expect(navigation).toContain('aria-label="DeepSeek" aria-current="true"');
  expect(navigation).toContain('width="16" height="16"');
  expect(markup.indexOf("</nav>")).toBeLessThan(markup.indexOf('<form class="provider-editor"'));
  expect(markup).not.toContain("新增提供商");
  expect(markup).not.toContain("自定义提供商");
  expect(markup).not.toContain("provider-template-picker");
  const css = source("../src/renderer/web-search-settings.css");
  expect(css).toMatch(/\.model-provider-panel\.web-search-provider-panel\s*\{\s*min-height: 0;/);
  expect(css).toMatch(
    /\.provider-list\s*\{[^}]*border-right: 1px solid var\(--color-border\);[^}]*border-bottom: 0;/,
  );
  expect(css).toMatch(/\.provider-detail-heading\s*\{\s*flex-wrap: wrap;/);
  expect(css).toMatch(/@media \(max-width: 1023px\)[\s\S]*\.provider-status\s*\{\s*display: none;/);
});
test("default-on web capability and model settings navigation preserve their order", () => {
  const markup = renderToStaticMarkup(createElement(CapabilitySettings));
  expect(markup.indexOf('aria-label="联网搜索"')).toBeLessThan(markup.indexOf('aria-label="子智能体"'));
  expect(markup.match(/<input[^>]*aria-label="联网搜索"[^>]*>/)?.[0]).toContain("checked");
  const page = source("../src/renderer/SettingsPage.tsx");
  expect(page.indexOf('["models", "模型", Braces]')).toBeGreaterThan(
    page.indexOf('["commands", "命令", Terminal]'),
  );
  expect(page.indexOf('["models", "模型", Braces]')).toBeLessThan(
    page.indexOf('["capabilities", "插件能力", Package]'),
  );
});

test("only actionable credential states describe the input; the configured state has no dangling description", () => {
  fixture.webSearch.hasApiKey = true;
  fixture.webSearch.enabled = true;
  fixture.webSearch.credentialsPersisted = true;
  let markup = render();
  expect(keyInput(markup)).not.toContain("aria-describedby");
  expect(markup).not.toContain('id="web-search-key-note"');
  fixture.webSearch.enabled = false;
  markup = render();
  expect(keyInput(markup)).toContain('aria-describedby="web-search-key-note"');
  expect(markup).toContain("DeepSeek 服务已停用，保存的 API Key 将保留。");
  fixture.webSearch.hasApiKey = false;
  markup = render();
  expect(markup).toContain("尚未配置可用的 API Key，联网服务不可用。");
  expect(markup.match(/id="web-search-key-note"/g)).toHaveLength(1);
  fixture.webSearch.credentialsLocked = true;
  markup = render();
  expect(markup).toContain("保存的 API Key 尚未解锁");
  expect(markup).not.toContain("尚未配置可用的 API Key");
  expect(markup.match(/id="web-search-key-note"/g)).toHaveLength(1);
});
