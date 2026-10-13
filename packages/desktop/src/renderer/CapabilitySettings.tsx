import { useState } from "react";
import type { CapabilityName, PublicSettings, Result } from "../shared/bridge.ts";
import { defaultCapabilities } from "../shared/config.ts";
import { unwrap, useStore } from "./store.ts";

const capabilities: {
  name: CapabilityName | "askUserQuestionAutoResolutionEnabled";
  label: string;
  description: string;
}[] = [
  {
    name: "toolBatching",
    label: "提示词-多工具调用",
    description: "提示助手在一次请求中调用多个工具，独立调用可并行执行。",
  },
  {
    name: "fileLinks",
    label: "提示词-文件链接格式",
    description: "使用桌面可点击的文件和网页链接格式，文件路径支持行号定位。",
  },
  {
    name: "fileContextReuse",
    label: "提示词-文件内容复用",
    description: "提示助手复用已读或成功编辑的文件内容，避免仅为验证或开始新回合而重复读取。",
  },
  {
    name: "askUserQuestion",
    label: "工具-向用户提问",
    description: "让助手通过单选、多选或自定义回答澄清问题，再继续执行。",
  },
  {
    name: "askUserQuestionAutoResolutionEnabled",
    label: "工具-提问自动继续",
    description: "五分钟未回答时使用最佳判断继续；开始作答后停止计时。",
  },
  {
    name: "subagents",
    label: "子智能体",
    description: "将独立任务交给专门的智能体并行处理，支持自定义智能体和模型，在侧栏查看完整过程。",
  },
];

export function CapabilitySettings() {
  const enabled = useStore((state) => state.settings?.capabilities ?? defaultCapabilities);
  const autoResolution = useStore(
    (state) => state.settings?.interface.askUserQuestionAutoResolutionEnabled ?? true,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (update: () => Promise<Result<PublicSettings>>) => {
    setSaving(true);
    setError("");
    try {
      useStore.setState({ settings: unwrap(await update()) });
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="capability-settings">
      <p className="global-settings-note">插件能力在新对话首次发送时生效；已有对话保留原有配置。</p>
      <h2 className="preview-heading">
        内置能力 <small>{capabilities.length}</small>
      </h2>
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
                checked={name === "askUserQuestionAutoResolutionEnabled" ? autoResolution : enabled[name]}
                disabled={saving}
                onChange={(event) => {
                  const checked = event.target.checked;
                  void save(() =>
                    name === "askUserQuestionAutoResolutionEnabled"
                      ? window.zpi.updatePreferences({ askUserQuestionAutoResolutionEnabled: checked })
                      : window.zpi.setCapabilityEnabled(name, checked),
                  );
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
