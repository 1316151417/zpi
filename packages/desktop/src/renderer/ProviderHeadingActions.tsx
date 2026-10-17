import * as Menu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { ActionHint } from "zpi-ui";

export type ProviderHeadingActionsProps = {
  enabled: boolean;
  name: string;
  disabled?: boolean;
  switchDisabled?: boolean;
  onEnabledChange: (enabled: boolean) => void;
  children?: ReactNode;
  onCloseAutoFocus?: ComponentProps<typeof Menu.Content>["onCloseAutoFocus"];
};

export function ProviderHeadingActions({
  enabled,
  name,
  disabled,
  switchDisabled = disabled,
  onEnabledChange,
  children,
  onCloseAutoFocus,
}: ProviderHeadingActionsProps) {
  return (
    <div className="provider-heading-actions">
      <ActionHint appearance="control" label={enabled ? "禁用供应商" : "启用供应商"}>
        <label className="settings-switch provider-enabled-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label={`启用供应商 ${name || "新提供商"}`}
            aria-checked={enabled}
            checked={enabled}
            disabled={switchDisabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
          <span />
        </label>
      </ActionHint>
      {children && (
        <Menu.Root>
          <Menu.Trigger className="provider-more" aria-label="供应商操作" disabled={disabled}>
            <MoreHorizontal size={16} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content
              className="provider-actions-menu"
              align="end"
              sideOffset={2}
              onCloseAutoFocus={onCloseAutoFocus}
            >
              {children}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      )}
    </div>
  );
}
