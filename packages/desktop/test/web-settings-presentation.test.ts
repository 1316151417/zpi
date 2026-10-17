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
afterEach(() => vi.unstubAllGlobals());
const render = () => renderToStaticMarkup(createElement(WebSearchSettings));
function tagWithClass(markup: string, className: string) {
  return (markup.match(/<[^/!][^>]*>/g) ?? []).find((tag) =>
    tag
      .match(/class="([^"]*)"/)?.[1]
      .split(/\s+/)
      .includes(className),
  );
}
const enableButton = (markup: string) => tagWithClass(markup, "web-search-enable");
const keyInput = (markup: string) => markup.match(/<input[^>]*id="web-search-api-key"[^>]*>/)?.[0];
const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const webCss = () => source("../src/renderer/web-search-settings.css");
const sharedCss = () => source("../src/renderer/workbench.css");
const baseCss = () => source("../../ui/src/styles.css");
function declarations(css: string, selector: string) {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules
    .filter(
      ([_, selectors]) =>
        selectors.trim() === selector || selectors.split(",").some((value) => value.trim() === selector),
    )
    .map(([_, _selectors, body]) =>
      Object.fromEntries(
        body
          .split(";")
          .filter((part) => part.includes(":"))
          .map((part) => {
            const colon = part.indexOf(":");
            return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
          }),
      ),
    );
}
function style(css: string, selector: string) {
  const matches = declarations(css, selector);
  expect(matches.length, `Missing CSS selector: ${selector}`).toBeGreaterThan(0);
  return Object.assign({}, ...matches) as Record<string, string>;
}

// SSR and stylesheet contracts establish shared rules, not browser layout or computed-cascade evidence.
test("an unconfigured install requires a key before enabling and never claims unavailable encryption", () => {
  const markup = render();
  expect(markup).not.toContain("系统加密存储不可用");
  expect(markup).toContain("输入 API Key");
  expect(markup).toContain("尚未配置 API Key，联网服务不可用");
  expect(keyInput(markup)).toContain('type="password"');
  expect(keyInput(markup)).toContain('value=""');
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
  expect(render()).toContain("留空保留现有密钥");
});

test("a configured key renders exactly one fixed mask without reading or embedding the raw credential", () => {
  fixture.webSearch.hasApiKey = true;
  fixture.webSearch.credentialsPersisted = true;
  const rawCredential = vi.fn(() => "fake-stored-secret-must-never-reach-the-renderer");
  Object.defineProperty(fixture.webSearch, "apiKey", { get: rawCredential });
  const getProviderCredentials = vi.fn();
  vi.stubGlobal("window", { zpi: { getProviderCredentials } });
  const markup = render();
  expect(keyInput(markup)).toContain('value="********"');
  expect(keyInput(markup)).toContain('type="text"');
  expect(keyInput(markup)).toContain('autoComplete="off"');
  expect(markup.match(/value="\*{8}"/g)).toHaveLength(1);
  expect(markup.match(/<input\b/g)).toHaveLength(1);
  expect(markup).not.toContain("fake-stored-secret");
  expect(rawCredential).not.toHaveBeenCalled();
  expect(getProviderCredentials).not.toHaveBeenCalled();
  expect(markup.match(/<button[^>]*aria-label="显示 API Key"[^>]*>/)?.[0]).toContain("disabled");
  expect(markup).toContain("已保存的 API Key 仅显示固定掩码");
  const component = source("../src/renderer/WebSearchSettings.tsx");
  expect(component).not.toMatch(/getProviderCredentials|getWebSearchCredentials|settings\??\.apiKey/);
});

test("provider state is independent from the global web capability", () => {
  fixture.webSearch.hasApiKey = true;
  fixture.webSearch.credentialsPersisted = true;
  let markup = render();
  expect(enableButton(markup)).not.toContain("disabled");
  expect(enableButton(markup)).toContain("primary");
  expect(markup).toContain("服务已停用");
  expect(markup).toContain(">启用</button>");
  fixture.webSearch.enabled = true;
  fixture.capabilities.webSearch = false;
  markup = render();
  expect(markup).toContain("服务已启用");
  expect(markup).toContain(">停用</button>");
  expect(markup).toContain("「插件能力」中的联网搜索已关闭");
  expect(enableButton(markup)).not.toContain("disabled");
  expect(enableButton(markup)).toContain("secondary");
});

test("locked stored keys retain the fixed mask and cannot be replaced or enabled", () => {
  fixture.webSearch.credentialsLocked = true;
  const markup = render();
  expect(markup).toContain("保存的 API Key 尚未解锁，联网服务暂不可用");
  expect(markup).not.toContain("尚未配置 API Key");
  expect(markup).not.toContain("系统加密存储不可用");
  expect(keyInput(markup)).toContain("disabled");
  expect(keyInput(markup)).toContain('value="********"');
  expect(enableButton(markup)).toContain("disabled");
  expect(markup.match(/<button[^>]*aria-label="显示 API Key"[^>]*>/)?.[0]).toContain("disabled");
  fixture.webSearch.enabled = true;
  expect(render()).toContain(">停用</button>");
  expect(enableButton(render())).not.toContain("disabled");
});

test("settings exposes one provider card and credential field without a misleading selection state", () => {
  const markup = render();
  expect(markup.match(/class="model-provider-panel web-search-provider-panel"/g)).toHaveLength(1);
  expect(markup).not.toContain('type="radio"');
  expect(markup).not.toContain('role="radiogroup"');
  expect(markup).not.toContain('aria-pressed="true"');
  expect(markup.match(/<input\b/g)).toHaveLength(1);
  expect(markup.match(/<input[^>]*type="password"[^>]*>/g)).toHaveLength(1);
  expect(markup).toContain('<label for="web-search-api-key">');
  expect(keyInput(markup)).toContain('aria-describedby="web-search-key-note"');
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
  const page = source("../src/renderer/SettingsPage.tsx");
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

test("the web editor reuses the model editor structure, 20px provider logo, and 14px visibility icon", () => {
  const markup = render();
  const model = source("../src/renderer/SettingsPage.tsx");
  for (const name of [
    "model-provider-panel",
    "provider-editor",
    "provider-details",
    "provider-detail-heading",
    "provider-heading-actions",
    "provider-connection-fields",
    "credential-input",
    "provider-footer",
    "modal-actions",
  ]) {
    expect(tagWithClass(markup, name), name).toBeDefined();
    expect(model, name).toContain(name);
  }
  expect(tagWithClass(markup, "provider-editor")).toMatch(/^<form /);
  expect(markup.match(/<img[^>]*class="provider-logo"[^>]*>/)?.[0]).toMatch(/width="20" height="20"/);
  expect(markup.match(/<svg[^>]*class="[^"]*lucide-eye[^"]*"[^>]*>/)?.[0]).toMatch(/width="14" height="14"/);
  expect(tagWithClass(markup, "web-search-save")).toContain("primary");
  fixture.webSearch.hasApiKey = true;
  expect(tagWithClass(render(), "web-search-remove")).toContain("secondary");
  expect(markup).not.toContain('class="provider-list"');
});

test("shared editor rules keep desktop/mobile padding, heading, label, and credential geometry aligned", () => {
  const css = sharedCss();
  expect(style(css, ".settings-screen .model-provider-panel")).toMatchObject({
    border: "1px solid var(--color-border)",
    "border-radius": "var(--radius-panel)",
    background: "var(--color-surface)",
  });
  expect(
    declarations(css, ".settings-screen .model-provider-panel .provider-editor").map((rule) => rule.padding),
  ).toEqual(["24px", "16px"]);
  expect(style(css, ".provider-details")).toMatchObject({ gap: "12px", "min-width": "0" });
  expect(style(css, ".provider-detail-heading")).toMatchObject({ gap: "8px", margin: "0" });
  expect(style(css, ".settings-screen .provider-detail-heading h2")).toMatchObject({
    "font-size": "calc(var(--ui-font-size) + 2px)",
    "font-weight": "600",
    margin: "0",
  });
  expect(style(css, ".settings-screen .provider-editor label")).toMatchObject({ gap: "4px", margin: "0" });
  expect(style(css, '.settings-screen .provider-editor input:not([type="checkbox"])')).toMatchObject({
    height: "32px",
    padding: "6px 12px",
    "border-radius": "var(--radius-nested)",
    background: "var(--color-input)",
  });
  expect(
    style(css, '.settings-screen .provider-editor .credential-input input:not([type="checkbox"])'),
  ).toMatchObject({
    "padding-right": "40px",
  });
  expect(style(css, ".credential-input button")).toMatchObject({
    width: "24px",
    height: "24px",
    right: "6px",
    top: "50%",
    transform: "translateY(-50%)",
  });
  const local = webCss();
  expect(style(local, ".settings-screen .model-provider-panel.web-search-provider-panel")).toMatchObject({
    "min-height": "0",
  });
  expect(local).not.toMatch(/\.web-search-(?:editor|heading|key-control|key-label|key-visibility)\b/);
  expect(local).not.toMatch(/(?:height:\s*36px|font-size:\s*\d+px|\.provider-editor[^{}]*\{)/);
});

test("footer actions share model sizing and secondary actions have theme-token boundaries", () => {
  const css = sharedCss();
  expect(style(css, ".settings-screen .provider-footer")).toMatchObject({
    gap: "12px",
    "padding-top": "12px",
    position: "static",
  });
  expect(style(css, ".provider-footer .modal-actions")).toMatchObject({ margin: "0", "flex-wrap": "wrap" });
  const action = style(webCss(), ".settings-screen .web-search-settings :is(.primary, .secondary)");
  const model = style(css, ".provider-footer .primary");
  for (const property of ["height", "padding", "border-radius"])
    expect(action[property]).toBe(model[property]);
  expect(style(webCss(), ".settings-screen .web-search-settings .secondary")).toMatchObject({
    color: "var(--color-foreground)",
    background: "var(--color-surface-muted)",
    "border-color": "var(--color-border)",
  });
  expect(style(webCss(), ".settings-screen .web-search-settings .web-search-remove").color).toBe(
    "var(--color-error)",
  );
});

test("primary hover keeps model-theme contrast and outranks the generic button hover rule", () => {
  const base = baseCss();
  expect(style(base, ".primary")).toMatchObject({
    color: "var(--color-on-primary)",
    background: "var(--color-primary)",
  });
  const primaryHover = style(base, ".primary:hover:not(:disabled)");
  expect(primaryHover.background).toBe("var(--color-primary)");
  expect(primaryHover.filter).toBe("brightness(0.96)");
  expect(primaryHover.color).toBeUndefined();
  expect(style(base, "button:hover:not(:disabled)").color).toBeUndefined();
  // (0,3,0) for .primary:hover:not(:disabled) outranks (0,2,1) for button:hover:not(:disabled).
  expect(base.indexOf(".primary:hover:not(:disabled)")).toBeGreaterThan(
    base.indexOf("button:hover:not(:disabled)"),
  );
  expect(webCss()).not.toMatch(/\.web-search-(?:save|enable)(?:\.primary)?:hover/);
  const tokens = source("../../ui/src/tokens.css");
  expect(style(tokens, ":root")).toMatchObject({
    "--color-primary": "#000000",
    "--color-on-primary": "#ffffff",
  });
  expect(style(tokens, '[data-theme="dark"]')).toMatchObject({
    "--color-primary": "#ffffff",
    "--color-on-primary": "#000000",
  });
});

test("secondary hover is scoped and disabled controls retain the shared noninteractive styling", () => {
  const css = webCss();
  expect(style(css, ".settings-screen .web-search-settings .secondary:hover:not(:disabled)").background).toBe(
    "var(--color-menu-hover)",
  );
  expect(style(baseCss(), "button:disabled")).toMatchObject({ opacity: "0.5", cursor: "default" });
  expect(css).not.toMatch(/(?:#[0-9a-f]{3,8}\b|rgba?\()/i);
  for (const [, selectors] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    if (selectors.includes(":hover")) expect(selectors).toContain(":not(:disabled)");
  }
});

test("keyboard focus stays visible via a theme-token shadow despite global outline suppression", () => {
  expect(style(baseCss(), "*:focus-visible").outline).toBe("none !important");
  expect(
    style(webCss(), ".settings-screen .web-search-settings :is(button, input):focus-visible")["box-shadow"],
  ).toBe("0 0 0 2px var(--color-focus)");
  expect(webCss()).not.toMatch(/outline:\s*none|box-shadow:\s*none/);
});
