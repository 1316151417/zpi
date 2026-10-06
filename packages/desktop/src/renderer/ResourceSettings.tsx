import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronDown,
  FilePenLine,
  FilePlus2,
  FileSearch,
  RefreshCcw,
  SquareTerminal,
  WandSparkles,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { PromptPreview, SkillSettings, ToolInfo } from "../shared/bridge.ts";
import { refresh, unwrap, useStore } from "./store.ts";
export function ResourceSettings({ page }: { page: "prompt" | "tools" | "skills" }) {
  const settings = useStore((s) => s.settings);
  const [preview, setPreview] = useState<PromptPreview>();
  const [tools, setTools] = useState<ToolInfo[]>([]),
    [toolName, setToolName] = useState("");
  const [skills, setSkills] = useState<SkillSettings>(),
    [skillPath, setSkillPath] = useState(""),
    [body, setBody] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [saving, setSaving] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    if (page === "prompt") {
      void window.zpi
        .previewPrompt()
        .then(unwrap)
        .then((value) => {
          if (active) setPreview(value);
        })
        .catch((error) => {
          if (active) {
            setPreview(undefined);
            setError(String(error));
          }
        });
    }
    if (page === "tools")
      void window.zpi
        .listTools()
        .then(unwrap)
        .then((v) => {
          if (active) setTools(v);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    if (page === "skills")
      void window.zpi
        .getSkillSettings()
        .then(unwrap)
        .then((v) => {
          if (active) setSkills(v);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    return () => {
      active = false;
    };
  }, [page, revision, settings]);
  useEffect(() => {
    let active = true;
    setBody("");
    if (skillPath)
      void window.zpi
        .readSkill(skillPath)
        .then(unwrap)
        .then((v) => {
          if (active) setBody(v);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    return () => {
      active = false;
    };
  }, [skillPath, revision]);
  const action = async (work: () => Promise<void>) => {
    setError("");
    setNotice("");
    setSaving(true);
    try {
      await work();
      setRevision((r) => r + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const adopt = (value: NonNullable<typeof settings>) => {
    useStore.setState({ settings: value });
  };
  return (
    <div className="resource-settings">
      <p className="global-settings-note">
        {page === "tools"
          ? "查看内置工具的能力与参数。工具定义只读，对所有任务生效。"
          : page === "prompt"
            ? "沿用 Pi 基础提示词，仅追加少量桌面规则。两部分均只读，下方分别展示。"
            : "全局默认配置，在新任务首次发送时生效；已有任务保留原技能开关。"}
      </p>
      {error && (
        <div className="run-error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {page === "prompt" && (
        <>
          <h2 className="preview-heading">
            基础系统提示词 <small>只读</small>
          </h2>
          <p>
            默认工作目录：{preview?.cwd}
            <br />
            新任务会使用其实际工作目录和项目指令。
          </p>
          <pre className="prompt-preview">{preview?.basePrompt ?? "正在生成预览…"}</pre>
          <h2 className="preview-heading">
            系统规则 <small>ZPI 补充 · 只读</small>
          </h2>
          <p>相比 Pi，仅补充文件和网页链接的桌面展示约定；基础提示词保持独立。</p>
          <pre className="system-rules-preview">{preview?.systemRules ?? "正在生成预览…"}</pre>
        </>
      )}
      {page === "tools" && (
        <>
          <div className="resource-group-heading">
            <h3>
              内置工具 <span>{tools.length}</span>
            </h3>
          </div>
          <div className="tool-resource-list">
            {tools.map((tool) => {
              const Icon =
                { read: FileSearch, bash: SquareTerminal, edit: FilePenLine, write: FilePlus2 }[tool.name] ??
                Wrench;
              const expanded = toolName === tool.name;
              return (
                <div className="tool-resource-item" key={tool.name}>
                  <button
                    className="tool-resource-row"
                    type="button"
                    aria-label={`${tool.name} ${tool.enabled ? "已启用" : "未启用"}`}
                    aria-expanded={expanded}
                    aria-controls={`tool-detail-${tool.name}`}
                    onClick={() => setToolName(expanded ? "" : tool.name)}
                  >
                    <span className="resource-avatar" aria-hidden="true">
                      <Icon size={16} />
                    </span>
                    <span className="tool-resource-summary">
                      <span>{tool.name}</span>
                      <small>{tool.promptSnippet ?? tool.description}</small>
                    </span>
                    <span className="tool-resource-status">{tool.enabled ? "已启用" : "未启用"}</span>
                    <ChevronDown size={16} className={expanded ? "rotated" : ""} aria-hidden="true" />
                  </button>
                  {expanded && (
                    <section
                      className="tool-resource-detail"
                      id={`tool-detail-${tool.name}`}
                      aria-label={`${tool.name} 工具定义`}
                    >
                      <p>{tool.description}</p>
                      <h4>
                        参数 Schema <small>只读</small>
                      </h4>
                      <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
                      {tool.promptSnippet && (
                        <>
                          <h4>System snippet</h4>
                          <pre>{tool.promptSnippet}</pre>
                        </>
                      )}
                      {!!tool.promptGuidelines?.length && (
                        <>
                          <h4>Guidelines</h4>
                          <pre>{tool.promptGuidelines.join("\n")}</pre>
                        </>
                      )}
                    </section>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {page === "skills" && (
        <>
          <div className="resource-group-heading">
            <h3>
              已安装 <span>{skills?.skills.length ?? 0}</span>
            </h3>
            <button
              className="resource-icon-button"
              type="button"
              aria-label="刷新技能"
              title="刷新技能"
              onClick={() => setRevision((r) => r + 1)}
            >
              <RefreshCcw size={16} />
            </button>
          </div>
          <p className="skill-directories">全局技能目录：{skills?.directories.join("、")}</p>
          {skills?.diagnostics.map((d) => (
            <p className="run-error" key={d.path}>
              {d.path}: {d.message}
            </p>
          ))}
          <div className="skill-resource-list">
            {skills?.skills.map((s) => (
              <div className="skill-resource-row" key={s.path}>
                <div className="resource-avatar" aria-hidden="true">
                  <WandSparkles size={16} />
                </div>
                <button
                  className="skill-resource-name"
                  aria-label={`${s.name} ${s.source} ${s.description}`}
                  type="button"
                  title={s.path}
                  onClick={() => setSkillPath(s.path)}
                >
                  <span>{s.name}</span>
                  <small>{s.description || "暂无描述"}</small>
                  {s.overriddenBy && <small>已被覆盖：{s.overriddenBy}</small>}
                </button>
                <label className="settings-switch">
                  <input
                    type="checkbox"
                    aria-label={`启用技能 ${s.name} ${s.source}`}
                    checked={s.enabled}
                    disabled={saving}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      void action(async () => {
                        adopt(unwrap(await window.zpi.setSkillEnabled(s.path, enabled)));
                        await refresh();
                      });
                    }}
                  />
                  <span aria-hidden="true" />
                </label>
              </div>
            ))}
            {skills?.skills.length === 0 && <p className="resource-empty">暂无技能</p>}
          </div>
          <Dialog.Root
            open={!!skillPath}
            onOpenChange={(open) => {
              if (!open) setSkillPath("");
            }}
          >
            <Dialog.Portal>
              <Dialog.Overlay className="modal-backdrop skill-detail-backdrop" />
              <Dialog.Content
                className="skill-detail-dialog"
                aria-describedby={undefined}
                onEscapeKeyDown={(event) => event.stopPropagation()}
              >
                <header>
                  <Dialog.Title>
                    {skills?.skills.find((s) => s.path === skillPath)?.name ?? "技能详情"}
                  </Dialog.Title>
                  <Dialog.Close aria-label="关闭技能详情">
                    <X size={16} />
                  </Dialog.Close>
                </header>
                <div className="skill-detail-body">
                  <p>{skills?.skills.find((s) => s.path === skillPath)?.description}</p>
                  <dl>
                    <div>
                      <dt>来源</dt>
                      <dd>{skills?.skills.find((s) => s.path === skillPath)?.source}</dd>
                    </div>
                    <div>
                      <dt>状态</dt>
                      <dd>
                        {skills?.skills.find((s) => s.path === skillPath)?.enabled ? "已启用" : "未启用"}
                      </dd>
                    </div>
                  </dl>
                  <div className="skill-detail-path">
                    <span>路径</span>
                    <code>{skillPath}</code>
                  </div>
                  <h3>SKILL.md（只读）</h3>
                  {error && <p role="alert">{error}</p>}
                  <pre>{body || "正在读取…"}</pre>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </>
      )}
    </div>
  );
}
