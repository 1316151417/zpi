import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  type ChangeEvent,
  Children,
  type ComponentProps,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionHint } from "zpi-ui";
import {
  ProviderHeadingActions,
  type ProviderHeadingActionsProps,
} from "../src/renderer/ProviderHeadingActions.tsx";

function heading(overrides: Partial<ProviderHeadingActionsProps> = {}) {
  return ProviderHeadingActions({ enabled: true, name: "DeepSeek", onEnabledChange: vi.fn(), ...overrides });
}

function element<Props>(node: ReactNode, type: unknown): ReactElement<Props> | undefined {
  for (const item of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(item)) continue;
    if (item.type === type) return item as ReactElement<Props>;
    const nested = element<Props>(item.props.children, type);
    if (nested) return nested;
  }
}

describe("shared provider heading actions", () => {
  it.each([false, true])("keeps the original model switch and hint, enabled=%s", (enabled) => {
    const tree = heading({ enabled });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('class="provider-heading-actions"');
    expect(html).toContain('class="settings-switch provider-enabled-switch"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="启用供应商 DeepSeek"');
    expect(html).toContain(`aria-checked="${enabled}"`);
    expect(element<ComponentProps<typeof ActionHint>>(tree, ActionHint)?.props).toMatchObject({
      appearance: "control",
      label: enabled ? "禁用供应商" : "启用供应商",
    });
    expect(element(tree, Menu.Root)).toBeUndefined();
  });

  it("passes switch changes to its caller and preserves the new-provider label", () => {
    const onEnabledChange = vi.fn();
    const tree = heading({ name: "", onEnabledChange });
    const input = element<ComponentProps<"input">>(tree, "input");
    expect(input?.props["aria-label"]).toBe("启用供应商 新提供商");
    input?.props.onChange?.({ target: { checked: false } } as ChangeEvent<HTMLInputElement>);
    expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("preserves the more menu, portal, menu contents, and close autofocus callback", () => {
    const onCloseAutoFocus = vi.fn();
    const children = createElement(Menu.Item, { className: "provider-action-delete" }, "移除 API Key");
    const tree = heading({ children, onCloseAutoFocus });
    expect(element(tree, Menu.Root)).toBeDefined();
    expect(element(tree, Menu.Portal)).toBeDefined();
    expect(element<ComponentProps<typeof Menu.Trigger>>(tree, Menu.Trigger)?.props).toMatchObject({
      className: "provider-more",
      "aria-label": "供应商操作",
    });
    const content = element<ComponentProps<typeof Menu.Content>>(tree, Menu.Content);
    expect(content?.props).toMatchObject({
      className: "provider-actions-menu",
      align: "end",
      sideOffset: 2,
      onCloseAutoFocus,
      children,
    });
    const event = new Event("closeAutoFocus", { cancelable: true });
    content?.props.onCloseAutoFocus?.(event);
    expect(onCloseAutoFocus).toHaveBeenCalledExactlyOnceWith(event);
    const html = renderToStaticMarkup(tree);
    expect(html.match(/<svg[^>]*>/)?.[0]).toContain('width="16" height="16"');
  });

  it("disables both controls while busy and allows credential loading to disable only the switch", () => {
    const children = createElement(Menu.Item, null, "删除");
    const busy = heading({ children, disabled: true });
    expect(element<ComponentProps<"input">>(busy, "input")?.props.disabled).toBe(true);
    expect(element<ComponentProps<typeof Menu.Trigger>>(busy, Menu.Trigger)?.props.disabled).toBe(true);
    const loading = heading({ children, disabled: false, switchDisabled: true });
    expect(element<ComponentProps<"input">>(loading, "input")?.props.disabled).toBe(true);
    expect(element<ComponentProps<typeof Menu.Trigger>>(loading, Menu.Trigger)?.props.disabled).toBe(false);
  });
});
