import type { ClipboardEvent, CompositionEvent, KeyboardEvent } from "react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { EditorHistory } from "./editor-history.ts";
import { displayReferences, referenceStyle } from "./Reference.tsx";
export interface MentionEditorHandle {
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}
function text(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.markdown) return node.dataset.markdown;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLBRElement) return "\n";
  return Array.from(node.childNodes)
    .map((child, i) => `${i && child instanceof HTMLDivElement ? "\n" : ""}${text(child)}`)
    .join("");
}
function offset(root: HTMLElement, node: Node | null, position: number): number {
  if (!node || !root.contains(node)) return text(root).length;
  let found = false,
    length = 0;
  const walk = (current: Node) => {
    if (found) return;
    if (current === node) {
      length +=
        current.nodeType === Node.TEXT_NODE
          ? position
          : Array.from(current.childNodes)
              .slice(0, position)
              .reduce((sum, c) => sum + text(c).length, 0);
      found = true;
      return;
    }
    if (
      current.nodeType === Node.TEXT_NODE ||
      current instanceof HTMLBRElement ||
      (current instanceof HTMLElement && current.dataset.markdown)
    ) {
      length += text(current).length;
      return;
    }
    for (const child of current.childNodes) walk(child);
  };
  walk(root);
  return length;
}
function selection(root: HTMLElement): [number, number] {
  const selected = window.getSelection();
  const start = offset(root, selected?.anchorNode ?? null, selected?.anchorOffset ?? 0);
  const end = offset(root, selected?.focusNode ?? null, selected?.focusOffset ?? 0);
  return [Math.min(start, end), Math.max(start, end)];
}
function setSelection(root: HTMLElement, start: number, end: number) {
  const find = (target: number): [Node, number] => {
    let used = 0,
      found: [Node, number] | undefined;
    const walk = (node: Node) => {
      if (found) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const length = text(node).length;
        if (target <= used + length) found = [node, Math.max(0, target - used)];
        else used += length;
      } else if (node instanceof HTMLElement && node.dataset.markdown && node.parentNode) {
        const length = text(node).length;
        if (target <= used + length)
          found = [
            node.parentNode,
            Array.from(node.parentNode.childNodes).indexOf(node as ChildNode) + (target > used ? 1 : 0),
          ];
        else used += length;
      } else for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return found ?? [root, root.childNodes.length];
  };
  const range = document.createRange();
  const a = find(start),
    b = find(end);
  range.setStart(...a);
  range.setEnd(...b);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}
export const MentionEditor = forwardRef<
  MentionEditorHandle,
  {
    value: string;
    disabled?: boolean;
    placeholder?: string;
    history?: EditorHistory;
    initialSelection?: [number, number];
    onFile?(path: string): void;
    onSelection?(selection: [number, number]): void;
    onChange(value: string, caret: number): void;
    onPaste(event: ClipboardEvent<HTMLDivElement>): void;
    onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
    onCompositionStart(event: CompositionEvent<HTMLDivElement>): void;
    onCompositionEnd(event: CompositionEvent<HTMLDivElement>): void;
  }
>(
  (
    {
      value,
      disabled = false,
      placeholder = "描述你想完成的工作…",
      history: providedHistory,
      initialSelection,
      onSelection,
      onFile,
      onChange,
      onPaste,
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
    },
    ref,
  ) => {
    const [compositionVersion, finishComposition] = useState(0);
    const root = useRef<HTMLDivElement>(null),
      composing = useRef(false);
    const compositionFrame = useRef<number | null>(null);
    const compositionCommit = useRef<(() => void) | null>(null);
    const commitComposition = () => {
      if (compositionFrame.current !== null) cancelAnimationFrame(compositionFrame.current);
      compositionCommit.current?.();
    };
    useEffect(
      () => () => {
        if (compositionFrame.current !== null) cancelAnimationFrame(compositionFrame.current);
      },
      [],
    );
    const pendingCaret = useRef<[number, number] | null>(initialSelection ?? null);
    const localHistory = useRef(new EditorHistory());
    const history = providedHistory ?? localHistory.current;
    const last = useRef({
      text: value,
      selection: initialSelection ?? ([value.length, value.length] as [number, number]),
    });
    const restoring = useRef(false);
    useEffect(() => {
      const changed = () => {
        const element = root.current;
        // IME can move its caret before the canonical text changes. Persist only a matching pair.
        if (!element || composing.current || document.activeElement !== element || text(element) !== value)
          return;
        const positions = selection(element);
        last.current.selection = positions;
        onSelection?.(positions);
      };
      document.addEventListener("selectionchange", changed);
      return () => document.removeEventListener("selectionchange", changed);
    }, [onSelection, value]);
    useImperativeHandle(
      ref,
      () => ({
        focus: () => root.current?.focus(),
        setSelectionRange: (start, end) => {
          pendingCaret.current = [start, end];
          if (root.current && end <= text(root.current).length) {
            setSelection(root.current, start, end);
            pendingCaret.current = null;
          }
        },
        get selectionStart() {
          return root.current?.contains(window.getSelection()?.anchorNode ?? null)
            ? selection(root.current)[0]
            : last.current.selection[0];
        },
        get selectionEnd() {
          return root.current?.contains(window.getSelection()?.anchorNode ?? null)
            ? selection(root.current)[1]
            : last.current.selection[1];
        },
      }),
      [value],
    );
    useLayoutEffect(() => {
      const element = root.current;
      if (!element || composing.current) return;
      if (last.current.text !== value) {
        if (!restoring.current) history.record(last.current, value);
        last.current = { text: value, selection: pendingCaret.current ?? last.current.selection };
        restoring.current = false;
      }
      const mentions = displayReferences(value);
      const rendered = Array.from(element.querySelectorAll<HTMLElement>("[data-markdown]"));
      if (
        text(element) === value &&
        mentions.length === rendered.length &&
        mentions.every((mention, i) => mention.markdown === rendered[i].dataset.markdown)
      ) {
        if (pendingCaret.current && document.activeElement === element) {
          setSelection(element, ...pendingCaret.current);
          pendingCaret.current = null;
        }
        return;
      }
      const active = document.activeElement === element,
        caret = pendingCaret.current ?? selection(element);
      const fragment = document.createDocumentFragment();
      let previous = 0;
      for (const mention of mentions) {
        fragment.append(document.createTextNode(value.slice(previous, mention.start)));
        const span = document.createElement("span");
        span.contentEditable = "false";
        span.className = `inline-mention ${mention.kind}`;
        span.dataset.markdown = mention.markdown;
        span.title = mention.path;
        if (mention.kind === "file") span.dataset.filePath = mention.path;
        span.textContent = mention.label;
        for (const [key, value] of Object.entries(
          referenceStyle(mention.kind, mention.kind === "command" ? mention.label : mention.path),
        ))
          span.style.setProperty(key, String(value));
        fragment.append(span);
        previous = mention.end;
      }
      fragment.append(document.createTextNode(value.slice(previous)));
      element.replaceChildren(fragment);
      if (active) {
        setSelection(element, ...caret);
        pendingCaret.current = null;
      } else pendingCaret.current = initialSelection ?? [value.length, value.length];
    }, [value, compositionVersion]);
    const replaceSelection = (start: number, end: number, inserted: string) => {
      const caret = start + inserted.length;
      pendingCaret.current = [caret, caret];
      const next = value.slice(0, start) + inserted + value.slice(end);
      history.record({ text: value, selection: [start, end] }, next);
      last.current = { text: next, selection: [caret, caret] };
      onChange(next, caret);
    };
    useLayoutEffect(() => {
      const element = root.current;
      if (!element) return;
      const beforeInput = (event: InputEvent) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        if (composing.current || event.isComposing) return;
        if (["insertText", "insertReplacementText"].includes(event.inputType) && event.data !== null) {
          event.preventDefault();
          replaceSelection(...selection(element), event.data);
        }
      };
      element.addEventListener("beforeinput", beforeInput);
      return () => element.removeEventListener("beforeinput", beforeInput);
    }, [value, history, onChange, disabled]);
    const change = () => {
      if (!root.current || composing.current) return;
      const next = text(root.current),
        positions = selection(root.current);
      pendingCaret.current = positions;
      history.record(last.current, next);
      last.current = { text: next, selection: positions };
      onChange(next, positions[1]);
    };
    return (
      // biome-ignore lint/a11y/useSemanticElements: Atomic inline mentions require a contenteditable textbox.
      <div
        ref={root}
        role="textbox"
        tabIndex={0}
        aria-label="消息"
        aria-multiline="true"
        data-placeholder={placeholder}
        className="mention-editor"
        contentEditable={!disabled}
        aria-disabled={disabled}
        suppressContentEditableWarning
        onFocus={() => {
          if (root.current && pendingCaret.current) {
            setSelection(root.current, ...pendingCaret.current);
            pendingCaret.current = null;
          }
        }}
        onBlur={() => {
          const element = root.current;
          if (!element || composing.current) return;
          const positions = element.contains(window.getSelection()?.anchorNode ?? null)
            ? selection(element)
            : last.current.selection;
          last.current.selection = positions;
          pendingCaret.current ??= positions;
          onSelection?.(positions);
        }}
        onClick={(event) => {
          const path = (event.target as HTMLElement).closest<HTMLElement>("[data-file-path]")?.dataset
            .filePath;
          if (path) onFile?.(path);
        }}
        onInput={(event) => {
          if (compositionCommit.current && !(event.nativeEvent as InputEvent).isComposing)
            commitComposition();
          else change();
        }}
        onKeyDown={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          // A separate key after IME commit must not be swallowed while awaiting a frame.
          if (!event.nativeEvent.isComposing && event.keyCode !== 229) commitComposition();
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "z" &&
            !composing.current &&
            root.current
          ) {
            event.preventDefault();
            const current = { text: value, selection: selection(root.current) };
            const next = event.shiftKey ? history.redo(current) : history.undo(current);
            if (next) {
              restoring.current = true;
              pendingCaret.current = next.selection;
              onChange(next.text, next.selection[1]);
            }
            return;
          }
          onKeyDown(event);
          if (
            event.defaultPrevented ||
            !root.current ||
            composing.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          let [start, end] = selection(root.current);
          if (event.key === "Enter" && event.shiftKey) {
            event.preventDefault();
            replaceSelection(start, end, "\n");
            return;
          }
          if (
            (event.key !== "Backspace" && event.key !== "Delete") ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          event.preventDefault();
          if (start === end) {
            if (event.key === "Backspace") start -= Array.from(value.slice(0, start)).at(-1)?.length ?? 0;
            else end += Array.from(value.slice(end))[0]?.length ?? 0;
          }
          for (const mention of displayReferences(value))
            if (start < mention.end && end > mention.start) {
              start = Math.min(start, mention.start);
              end = Math.max(end, mention.end);
            }
          replaceSelection(start, end, "");
        }}
        onCompositionStart={(event) => {
          commitComposition();
          if (root.current) last.current = { text: text(root.current), selection: selection(root.current) };
          composing.current = true;
          onCompositionStart(event);
        }}
        onCompositionEnd={(event) => {
          // Chromium commits the final IME input after compositionend. Rebuilding its
          // editable DOM during that commit can reset the native caret to the start.
          const commit = () => {
            compositionFrame.current = null;
            compositionCommit.current = null;
            composing.current = false;
            onCompositionEnd(event);
            change();
            finishComposition((version) => version + 1);
          };
          compositionCommit.current = commit;
          compositionFrame.current = requestAnimationFrame(commit);
        }}
        onPaste={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          onPaste(event);
          if (event.defaultPrevented || !root.current) return;
          event.preventDefault();
          const [start, end] = selection(root.current);
          const inserted = event.clipboardData.getData("text/plain");
          replaceSelection(start, end, inserted);
        }}
        onCopy={(event) => {
          if (!root.current) return;
          const [start, end] = selection(root.current);
          if (start === end) return;
          event.preventDefault();
          event.clipboardData.setData("text/plain", value.slice(start, end));
        }}
        onCut={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          if (!root.current) return;
          const [start, end] = selection(root.current);
          event.preventDefault();
          event.clipboardData.setData("text/plain", value.slice(start, end));
          replaceSelection(start, end, "");
        }}
      />
    );
  },
);
