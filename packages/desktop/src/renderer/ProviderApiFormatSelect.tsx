// Layout and protocol labels follow ZCode ProviderApiFormatSelect (Apache-2.0).
import { type ProviderApi, providerApis } from "ZPI-ai";
import { SettingsSelect } from "./SettingsSelect.tsx";

const labels: Record<ProviderApi, string> = {
  "anthropic-messages": "Anthropic Messages (/v1/messages)",
  "openai-completions": "OpenAI Chat Completions (/chat/completions)",
  "openai-responses": "OpenAI Responses (/responses)",
};
export function ProviderApiFormatSelect({
  value,
  preset,
  disabled,
  onChange,
}: {
  value: ProviderApi;
  preset?: string;
  disabled?: boolean;
  onChange: (api: ProviderApi) => void;
}) {
  return (
    <SettingsSelect
      id="provider-api-format"
      label="API 格式"
      value={value}
      options={providerApis(preset).map((api) => ({ value: api, label: labels[api] }))}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
