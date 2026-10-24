import { useState } from "react";
import type { CapabilityName, PublicSettings, Result } from "../shared/bridge.ts";
import { defaultCapabilities } from "../shared/config.ts";
import { useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";

const capabilities: {
  name: CapabilityName;
  label: string;
  description: string;
}[] = [
  {
    name: "communicationStyle",
    label: "指令 · 交互方式",
    description: "简要说明进展，在最终回复中完整交付结论；按问题和用户经验调整表达，保持代码风格一致。",
  },
  {
    name: "toolBatching",
    label: "指令 · 多工具调用",
    description: "提示助手在一次请求中调用多个工具，独立调用可并行执行。",
  },
  {
    name: "fileLinks",
    label: "指令 · 文件链接格式",
    description: "使用桌面可点击的文件和网页链接格式，文件路径支持行号定位。",
  },
  {
    name: "fileContextReuse",
    label: "指令 · 文件内容复用",
    description: "提示助手复用已读或成功编辑的文件内容，避免仅为验证或开始新回合而重复读取。",
  },
  {
    name: "proactiveExecution",
    label: "指令 · 主动推进",
    description: "主动完成已授权的必要工作，减少不必要的确认；用户要求先确认时仍等待。",
  },
  {
    name: "askUserQuestion",
    label: "工具 · 向用户提问",
    description: "让助手通过单选、多选或自定义回答澄清问题，再继续执行。",
  },
];

export function CapabilitySettings() {
  const enabled = useStore((state) => state.settings?.capabilities ?? defaultCapabilities);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (update: () => Promise<Result<PublicSettings>>) => {
    setSaving(true);
    setError("");
    try {
      useStore.setState({ settings: unwrap(await update()) });
    } catch (error) {
      setError(userErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="capability-settings">
      <div className="settings-group">
        {capabilities.map(({ name, label, description }) => (
          <div className="settings-row" key={name}>
            <span className="settings-row-copy">
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
            <span className="settings-switch">
              <input
                type="checkbox"
                aria-label={label}
                checked={enabled[name]}
                disabled={saving}
                onChange={(event) => {
                  const checked = event.target.checked;
                  void save(() => window.zpi.setCapabilityEnabled(name, checked));
                }}
              />
              <span aria-hidden="true" />
            </span>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
    </div>
  );
}
