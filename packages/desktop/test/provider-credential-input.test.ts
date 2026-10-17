import { Children, type ComponentPropsWithRef, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderCredentialInput,
  type ProviderCredentialInputProps,
} from "../src/renderer/ProviderCredentialInput.tsx";

function credential(overrides: Partial<ProviderCredentialInputProps> = {}) {
  return ProviderCredentialInput({ visible: false, onToggleVisibility: vi.fn(), ...overrides });
}

describe("shared provider credential input", () => {
  it.each([false, true])("keeps model credential markup and 14px visibility icon, visible=%s", (visible) => {
    const html = renderToStaticMarkup(credential({ visible, value: "test-credential", readOnly: true }));
    expect(html).toMatch(/^<span class="credential-input"><input /);
    expect(html).toContain('aria-label="API key"');
    expect(html).toContain(`type="${visible ? "text" : "password"}"`);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('value="test-credential"');
    expect(html).toContain(`aria-label="${visible ? "隐藏" : "显示"} API key"`);
    expect(html).toContain(`lucide-${visible ? "eye-off" : "eye"}`);
    expect(html.match(/<svg[^>]*>/)?.[0]).toContain('width="14" height="14"');
    expect(html.match(/<input\b/g)).toHaveLength(1);
    expect(html.match(/<button\b/g)).toHaveLength(1);
  });

  it("forwards input attributes, ref and event handlers without owning credential state", () => {
    const ref = { current: null };
    const onChange = vi.fn();
    const onBlur = vi.fn();
    const onFocus = vi.fn();
    const onKeyDown = vi.fn();
    const tree = credential({
      ref,
      id: "web-search-api-key",
      type: "password",
      value: "",
      placeholder: "输入 API Key",
      autoComplete: "new-password",
      "aria-label": "联网 API key",
      "aria-describedby": "web-search-key-note",
      onChange,
      onBlur,
      onFocus,
      onKeyDown,
    });
    const input = Children.toArray(tree.props.children).find(
      (node) => isValidElement<ComponentPropsWithRef<"input">>(node) && node.type === "input",
    );
    expect(isValidElement(input)).toBe(true);
    if (!isValidElement<ComponentPropsWithRef<"input">>(input)) throw new Error("Missing input");
    expect(input.props).toMatchObject({
      ref,
      id: "web-search-api-key",
      type: "password",
      value: "",
      placeholder: "输入 API Key",
      autoComplete: "new-password",
      "aria-label": "联网 API key",
      "aria-describedby": "web-search-key-note",
      onChange,
      onBlur,
      onFocus,
      onKeyDown,
    });
  });

  it("keeps credential editing and reveal disablement independent", () => {
    const onToggleVisibility = vi.fn();
    const tree = credential({ disabled: true, onToggleVisibility });
    const button = Children.toArray(tree.props.children).find(
      (node) => isValidElement<ComponentPropsWithRef<"button">>(node) && node.type === "button",
    );
    if (!isValidElement<ComponentPropsWithRef<"button">>(button)) throw new Error("Missing reveal button");
    expect(button.props).toMatchObject({ type: "button", onClick: onToggleVisibility });
    expect(button.props.disabled).toBeUndefined();
    const html = renderToStaticMarkup(credential({ visibilityDisabled: true }));
    expect(html.match(/<button[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html.match(/<input[^>]*>/)?.[0]).not.toContain("disabled");
  });

  it("uses a custom label for both input and reveal controls", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCredentialInput, {
        visible: true,
        onToggleVisibility() {},
        label: "访问令牌",
      }),
    );
    expect(html).toContain('aria-label="访问令牌"');
    expect(html).toContain('aria-label="隐藏 访问令牌"');
  });

  it("shows a pending hide control while a masked credential remains a password", () => {
    const html = renderToStaticMarkup(
      credential({
        visible: false,
        visibilityLabel: "隐藏 API Key",
        visibilityPressed: true,
        value: "********",
        readOnly: true,
      }),
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="隐藏 API Key"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("lucide-eye-off");
  });
});
