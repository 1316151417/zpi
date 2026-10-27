import { useEffect, useMemo, useState } from "react";
import { parseSelectionPrompt } from "../conversation-selections.ts";
import type { FindTarget } from "../find.ts";
import type { LinkContext } from "../link-target.ts";
import type { RunView } from "../types.ts";
import { createMarkdownFindText } from "./markdown-find.ts";
import { runPresentation } from "./process-presentation.ts";
import { messageReferences } from "./Reference.tsx";

const emptyTargets: readonly FindTarget[] = [];

export function createConversationFindIndex(
  workspace: LinkContext | undefined,
  commandNames: readonly string[],
  agentNames: readonly string[],
) {
  let markdown: ReturnType<typeof createMarkdownFindText> | undefined;
  const cache = new WeakMap<RunView, readonly FindTarget[]>();
  const read = (run: RunView): readonly FindTarget[] => {
    const cached = cache.get(run);
    if (cached) return cached;
    const targets: FindTarget[] = [];
    if (run.kind !== "compact") {
      if (run.subagentNotification)
        targets.push({
          key: `${run.runId}:user`,
          text: run.subagentNotification.description,
          runId: run.runId,
        });
      if (!run.subagentNotification) {
        const user = parseSelectionPrompt(run.userMessage).text;
        let text = "",
          from = 0;
        const references = messageReferences(user, run.fileReferences, commandNames, agentNames);
        for (const mention of references.inline) {
          text += user.slice(from, mention.start) + mention.label;
          from = mention.end;
        }
        targets.push({
          key: `${run.runId}:user`,
          text: text + user.slice(from) + references.trailing.map((reference) => reference.label).join(""),
          runId: run.runId,
        });
      }
      const { answer } = runPresentation(run);
      for (const block of run.orderedBlocks) {
        if (block.type !== "text") continue;
        let text: string | undefined;
        if (run.status !== "running") {
          markdown ??= createMarkdownFindText(workspace);
          text = markdown(block.text);
        }
        targets.push({
          key: block === answer ? `${run.runId}:answer` : block.id,
          text: text ?? "",
          runId: run.runId,
          rendered: text === undefined,
        });
      }
    }
    cache.set(run, targets);
    return targets;
  };
  return { read, peek: (run: RunView) => cache.get(run) };
}

/** Index saved history in short tasks; cancelling a query/session never finishes the old queue. */
export function useConversationFindTargets({
  runs,
  active,
  sessionId,
  workspace,
  commandNames,
  agentNames,
}: {
  runs: RunView[];
  active: boolean;
  sessionId: string;
  workspace?: LinkContext;
  commandNames: readonly string[];
  agentNames: readonly string[];
}) {
  const commands = JSON.stringify(commandNames),
    agents = JSON.stringify(agentNames);
  const index = useMemo(
    () => createConversationFindIndex(workspace, JSON.parse(commands), JSON.parse(agents)),
    [sessionId, workspace?.cwd, workspace?.home, workspace?.documentPath, commands, agents],
  );
  const [state, setState] = useState<{ sessionId: string; index: typeof index; targets: FindTarget[] }>();
  useEffect(() => {
    if (!active) {
      setState(undefined);
      return;
    }
    let cursor = 0;
    const slots = runs.map((run) => index.peek(run));
    const pending = runs.flatMap((_, i) => (slots[i] ? [] : [i]));
    const step = () => {
      const start = performance.now();
      let count = 0;
      while (cursor < pending.length && count++ < 4) {
        const i = pending[cursor++];
        slots[i] = index.read(runs[i]);
        if (performance.now() - start >= 8) break;
      }
      const targets = slots.flatMap((targets) => targets ?? []);
      setState((current) => {
        if (current?.sessionId === sessionId && current.index !== index && cursor < pending.length)
          return current;
        if (
          current?.index === index &&
          current.targets.length === targets.length &&
          targets.every((target, i) => target === current.targets[i])
        )
          return current;
        return { sessionId, index, targets };
      });
      if (cursor < pending.length) timer = setTimeout(step, 0);
    };
    let timer = setTimeout(step, 0);
    return () => clearTimeout(timer);
  }, [index, active, runs, sessionId]);
  return active && state?.sessionId === sessionId ? state.targets : emptyTargets;
}
