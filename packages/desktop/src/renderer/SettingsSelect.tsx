import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";

export function SettingsSelect<T extends string>({
  label,
  id,
  value,
  options,
  onChange,
}: {
  label: string;
  id?: string;
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  onChange(value: T): void;
}) {
  return (
    <Select.Root value={value} onValueChange={(value) => onChange(value as T)}>
      <Select.Trigger id={id} className="settings-select-trigger" aria-label={label}>
        <Select.Value />
        <Select.Icon asChild>
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="settings-select-menu"
          position="item-aligned"
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Select.ScrollUpButton className="settings-select-scroll">
            <ChevronUp size={14} />
          </Select.ScrollUpButton>
          <Select.Viewport className="settings-select-options">
            {options.map((option) => (
              <Select.Item className="settings-select-option" key={option.value} value={option.value}>
                <Select.ItemText>
                  <span className="settings-select-value">
                    {option.icon}
                    {option.label}
                  </span>
                </Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={16} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="settings-select-scroll">
            <ChevronDown size={14} />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
