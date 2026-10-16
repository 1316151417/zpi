import * as Tooltip from "@radix-ui/react-tooltip";
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, it } from "vitest";
import { ActionHint } from "../src/components/MessageActions.tsx";

function content(node: ReactNode): ReactElement<{ hideWhenDetached?: boolean }> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; hideWhenDetached?: boolean }>(child)) continue;
    if (child.type === Tooltip.Content) return child;
    const found = content(child.props.children);
    if (found) return found;
  }
}

it.each([undefined, false, true])("forwards hideWhenDetached=%s without changing other hints", (value) => {
  const result = content(
    ActionHint({ label: "Archive", children: createElement("button"), hideWhenDetached: value }),
  );
  expect(result).toBeDefined();
  expect(result?.props.hideWhenDetached).toBe(value);
});
