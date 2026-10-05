// Adapted from ZCode ProviderModelReasoningLevelEditor (Apache-2.0).

import { Plus, X } from "lucide-react";
import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

export function ReasoningLevelEditor({
  values,
  overridden,
  addLabel,
  deleteLabel,
  onChange,
}: {
  values: readonly string[];
  overridden: boolean;
  addLabel: string;
  deleteLabel: string;
  onChange: (values: readonly string[]) => void;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingIndex !== null) inputRef.current?.focus();
  }, [editingIndex]);

  const beginEdit = (index: number, value = values[index] ?? "") => {
    setEditingIndex(index);
    setEditingValue(value);
  };
  const cancelEdit = () => {
    setEditingIndex(null);
    setEditingValue("");
  };
  const commitEdit = () => {
    if (editingIndex === null) return;
    const nextValue = editingValue.trim();
    if (!nextValue || values.some((value, index) => index !== editingIndex && value === nextValue)) {
      return;
    }
    // 打开后原样失焦不是用户覆盖；否则仅查看档位就会把整组写成个人配置。
    if (editingIndex < values.length && nextValue === values[editingIndex]) {
      cancelEdit();
      return;
    }
    const next = [...values];
    if (editingIndex === values.length) next.push(nextValue);
    else next[editingIndex] = nextValue;
    onChange(next);
    cancelEdit();
  };
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= values.length || to >= values.length) return;
    const next = [...values];
    const [value] = next.splice(from, 1);
    next.splice(to, 0, value);
    // drop 时立即提交本地顺序，避免等待外部刷新后先回位再跳转。
    onChange(next);
  };
  const handleChipKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      move(index, event.key === "ArrowLeft" ? index - 1 : index + 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      beginEdit(index);
    }
  };
  const handleDrop = (event: DragEvent<HTMLFieldSetElement>, targetIndex: number) => {
    event.preventDefault();
    if (draggingIndex !== null) move(draggingIndex, targetIndex);
    setDraggingIndex(null);
  };

  // 档位外层是普通 div；若沿用 content-box，h-8 会再叠加 2px 边框，
  // 导致静态档位、编辑框和新增按钮的实际高度不一致。
  return (
    <div
      className="model-reasoning-editor"
      data-personal-override={overridden}
      data-model-reasoning-level-editor="true"
    >
      {values.map((value, index) => (
        <fieldset
          aria-label={`推理等级 ${value}`}
          key={`${value}-${index}`}
          data-model-reasoning-chip="true"
          data-personal-override={overridden}
          draggable={editingIndex !== index}
          onDragStart={(event) => {
            setDraggingIndex(index);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => handleDrop(event, index)}
          onDragEnd={() => setDraggingIndex(null)}
          className="model-reasoning-chip"
          data-dragging={draggingIndex === index}
        >
          {editingIndex === index ? (
            <input
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              ref={inputRef}
              value={editingValue}
              className="model-reasoning-input"
              aria-label="推理等级名称"
              data-model-reasoning-level-input="true"
              onChange={(event) => setEditingValue(event.target.value)}
              onBlur={commitEdit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitEdit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEdit();
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="model-reasoning-value"
              onClick={() => beginEdit(index)}
              onKeyDown={(event) => handleChipKeyDown(event, index)}
            >
              {value}
            </button>
          )}
          <button
            type="button"
            className="model-reasoning-remove"
            aria-label={`${deleteLabel}: ${value}`}
            disabled={values.length <= 1}
            onClick={() => onChange(values.filter((_, valueIndex) => valueIndex !== index))}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </fieldset>
      ))}
      {editingIndex === values.length ? (
        <input
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          ref={inputRef}
          value={editingValue}
          className="model-reasoning-input model-reasoning-new"
          aria-label="推理等级名称"
          data-model-reasoning-level-input="true"
          onChange={(event) => setEditingValue(event.target.value)}
          onBlur={commitEdit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitEdit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
        />
      ) : (
        <button
          type="button"
          data-model-reasoning-level-add="true"
          className="model-reasoning-add"
          onClick={() => beginEdit(values.length)}
        >
          <Plus size={14} aria-hidden="true" />
          <span className="sr-only">{addLabel}</span>
        </button>
      )}
    </div>
  );
}
