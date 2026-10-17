import { Eye, EyeOff } from "lucide-react";
import type { ComponentPropsWithRef } from "react";

export type ProviderCredentialInputProps = ComponentPropsWithRef<"input"> & {
  visible: boolean;
  onToggleVisibility: () => void;
  visibilityDisabled?: boolean;
  visibilityLabel?: string;
  visibilityPressed?: boolean;
  label?: string;
};

export function ProviderCredentialInput({
  visible,
  onToggleVisibility,
  visibilityDisabled,
  visibilityLabel,
  visibilityPressed = visible,
  label = "API key",
  ...inputProps
}: ProviderCredentialInputProps) {
  return (
    <span className="credential-input">
      <input aria-label={label} type={visible ? "text" : "password"} autoComplete="off" {...inputProps} />
      <button
        type="button"
        aria-label={visibilityLabel ?? (visibilityPressed ? `隐藏 ${label}` : `显示 ${label}`)}
        aria-pressed={visibilityPressed}
        onClick={onToggleVisibility}
        disabled={visibilityDisabled}
      >
        {visibilityPressed ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </span>
  );
}
