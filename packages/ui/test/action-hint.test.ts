import * as Tooltip from "@radix-ui/react-tooltip";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ActionHint } from "../src/components/MessageActions.tsx";

// Render through React so the hint's hooks run with a dispatcher. Only replace
// the portal boundary and content sink; keep the real tooltip owner and trigger.
vi.mock("@radix-ui/react-tooltip", async (importOriginal) => ({
  ...(await importOriginal<typeof Tooltip>()),
  Portal: ({ children }: { children: ReactNode }) => children,
  Content: vi.fn(() => null),
}));
afterEach(() => vi.clearAllMocks());

it.each([undefined, false, true])("forwards hideWhenDetached=%s without changing other hints", (value) => {
  renderToStaticMarkup(
    createElement(ActionHint, {
      label: "Archive",
      // biome-ignore lint/correctness/noChildrenProp: ActionHint requires children in its typed props.
      children: createElement("button"),
      open: true,
      hideWhenDetached: value,
    }),
  );
  expect(Tooltip.Content).toHaveBeenCalled();
  expect(vi.mocked(Tooltip.Content).mock.calls[0][0].hideWhenDetached).toBe(value);
});
