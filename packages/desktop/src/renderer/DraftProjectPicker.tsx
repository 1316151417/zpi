import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Folder, FolderPlus, MessageCircle, Search, X } from "lucide-react";
import { useState } from "react";
import { newSession, refresh, report, unwrap, useStore } from "./store.ts";

export function DraftProjectPicker({ projectId }: { projectId: string | null }) {
  const projects = useStore((state) => state.projects);
  const project = projects.find((item) => item.id === projectId);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const change = async (id: string | null) => {
    setPending(true);
    try {
      await newSession(id);
    } catch (error) {
      report(error);
    } finally {
      setPending(false);
    }
  };
  const openFolder = async () => {
    setPending(true);
    try {
      const project = unwrap(await window.ZPI.addProject());
      if (project) {
        await refresh();
        await newSession(project.id);
      }
    } catch (error) {
      report(error);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="draft-project-header">
      <Menu.Root
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
      >
        <div className={`draft-project-chip${project ? " attached" : ""}`}>
          {project && (
            <button
              className="draft-project-detach"
              title="取消选择当前项目"
              aria-label="取消选择当前项目"
              disabled={pending}
              onClick={() => void change(null)}
            >
              <X size={14} />
            </button>
          )}
          <Menu.Trigger className="draft-project-trigger" aria-label="选择项目" disabled={pending}>
            <Folder size={16} />
            <span>{project?.name ?? "选择项目"}</span>
            <ChevronDown size={14} />
          </Menu.Trigger>
        </div>
        <Menu.Portal>
          <Menu.Content className="draft-project-menu" align="start" side="top" sideOffset={4}>
            <div className="draft-project-search">
              <Search size={16} />
              <input
                onKeyDown={(event) => {
                  if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
                }}
                aria-label="搜索项目"
                placeholder="搜索工作区"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="draft-project-options">
              {projects
                .filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
                .map((item) => (
                  <Menu.Item
                    key={item.id}
                    title={item.path}
                    className="draft-project-option"
                    onSelect={() => void change(item.id)}
                  >
                    <Folder size={16} />
                    <span>{item.name}</span>
                    {item.id === projectId && <Check size={16} />}
                  </Menu.Item>
                ))}
              {!projects.some((item) => item.name.toLowerCase().includes(query.toLowerCase())) && (
                <p className="draft-project-empty">没有匹配的工作区</p>
              )}
              <Menu.Separator />
              <Menu.Item className="draft-project-option" onSelect={() => void openFolder()}>
                <FolderPlus size={16} />
                <span>打开文件夹</span>
              </Menu.Item>
              <Menu.Item className="draft-project-option" onSelect={() => void change(null)}>
                <MessageCircle size={16} />
                <span>不在项目中工作</span>
                {projectId === null && <Check size={16} />}
              </Menu.Item>
            </div>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
