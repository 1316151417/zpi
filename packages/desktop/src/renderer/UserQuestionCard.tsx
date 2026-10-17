// Adapted from ZCode's ElicitationDialog interaction and layout (Apache-2.0).

import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Info } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { UserQuestionRequest, UserQuestionResponse } from "zpi-ui";
import { type QuestionDraft, questionDrafts, report, unwrap } from "./store.ts";
import { userErrorMessage } from "./user-error.ts";

type AnswerDraft = QuestionDraft["answers"][number];
function preferredOption(question: UserQuestionRequest["questions"][number], answer: AnswerDraft) {
  const selected = question.options.findIndex((option) => answer.selected.includes(option.label));
  return selected >= 0 ? selected : answer.custom.trim() ? question.options.length : -1;
}
export function UserQuestionCard({
  sessionId,
  request,
  visible = true,
}: {
  sessionId: string;
  request: UserQuestionRequest;
  visible?: boolean;
}) {
  const [draft, setDraft] = useState<QuestionDraft>(() => {
    const saved = questionDrafts.get(sessionId);
    return saved?.requestId === request.id
      ? saved
      : {
          requestId: request.id,
          index: 0,
          answers: request.questions.map(() => ({ selected: [], custom: "" })),
        };
  });
  const [active, setActive] = useState(-1);
  const [dialogExpanded, setDialogExpanded] = useState(true);
  const [questionExpanded, setQuestionExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const card = useRef<HTMLDivElement>(null);
  const interacted = useRef(false);
  const composing = useRef(false);
  const submitting = useRef(false);
  const [now, setNow] = useState(Date.now);
  const deadline =
    request.autoResolution?.phase !== "snoozed" ? request.autoResolution?.deadlineAt : undefined;
  useEffect(() => {
    if (!visible || !deadline) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      clearTimeout(timer);
      const time = Date.now();
      setNow(time);
      if (document.visibilityState === "hidden") return;
      const remaining = deadline - time;
      if (remaining > 0) {
        const seconds = Math.max(1, Math.floor(remaining / 1000));
        const delay =
          remaining >= 60_000
            ? remaining - 59_999
            : seconds <= 1
              ? remaining
              : Math.max(1, remaining - (seconds * 1000 - 1));
        timer = setTimeout(tick, delay);
      }
    };
    tick();
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [deadline, visible]);
  const remainingMs = deadline ? deadline - now : 0;
  const remaining = remainingMs > 0 && remainingMs < 60_000 ? Math.max(1, Math.floor(remainingMs / 1000)) : 0;
  const snooze = () => {
    if (interacted.current || !deadline) return;
    interacted.current = true;
    void window.zpi
      .snoozeQuestion(sessionId, request.id)
      .then(unwrap)
      .catch((error) => {
        interacted.current = false;
        report(error);
      });
  };
  const question = request.questions[draft.index];
  const answer = draft.answers[draft.index];
  const update = (next: QuestionDraft) => {
    questionDrafts.set(sessionId, next);
    setDraft(next);
  };
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      if (active < 0) card.current?.focus();
      else card.current?.querySelector<HTMLElement>(`[data-question-option="${active}"]`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, active, draft.index]);
  const move = (index: number, answers = draft.answers) => {
    snooze();
    update({ ...draft, index, answers });
    setActive(preferredOption(request.questions[index], answers[index]));
    setQuestionExpanded(false);
  };
  const respond = async (answers: AnswerDraft[], dismiss = false) => {
    if (submitting.current) return;
    submitting.current = true;
    snooze();
    setSending(true);
    setError("");
    const response: UserQuestionResponse = { answers: Object.create(null), annotations: Object.create(null) };
    if (!dismiss)
      request.questions.forEach((q, index) => {
        const value = answers[index];
        const parts = [...value.selected, ...(value.custom.trim() ? [value.custom.trim()] : [])];
        if (parts.length) response.answers[q.question] = parts.join(", ");
        const preview = q.options.find((option) => value.selected.includes(option.label))?.preview;
        if (preview && response.annotations) response.annotations[q.question] = { preview };
      });
    try {
      unwrap(await window.zpi.respondToQuestion(sessionId, request.id, response));
      if (questionDrafts.get(sessionId)?.requestId === request.id) questionDrafts.delete(sessionId);
    } catch (error) {
      setError(userErrorMessage(error));
      submitting.current = false;
      setSending(false);
    }
  };
  const advance = (answers = draft.answers) => {
    snooze();
    if (draft.index === request.questions.length - 1) void respond(answers);
    else move(draft.index + 1, answers);
  };
  const withFocusedOption = () => {
    const option = question.options[active];
    if (question.multiSelect || !option || answer.selected.length || answer.custom.trim())
      return draft.answers;
    return draft.answers.map((value, index) =>
      index === draft.index ? { ...value, selected: [option.label] } : value,
    );
  };
  const choose = (index: number) => {
    if (sending) return;
    snooze();
    const option = question.options[index];
    if (!option) {
      card.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      return;
    }
    const selected = question.multiSelect
      ? answer.selected.includes(option.label)
        ? answer.selected.filter((label) => label !== option.label)
        : [...answer.selected, option.label]
      : [option.label];
    const answers = draft.answers.map((value, i) =>
      i === draft.index ? { selected, custom: question.multiSelect ? value.custom : "" } : value,
    );
    update({ ...draft, answers });
    if (!question.multiSelect) advance(answers);
  };
  const navigate = (direction: number) => {
    snooze();
    const count = question.options.length + 1;
    const index = active < 0 ? (direction < 0 ? count - 1 : 0) : (active + direction + count) % count;
    setActive(index);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || sending) return;
    if (
      event.key !== "Escape" &&
      event.target instanceof HTMLElement &&
      event.target.closest("footer,nav,.question-expand-text,.question-collapsed-summary")
    )
      return;
    const custom = event.target instanceof HTMLTextAreaElement;
    if (event.key === "Escape") {
      event.preventDefault();
      if (draft.index > 0) move(draft.index - 1);
      else void respond([], true);
    } else if (
      (!custom && event.key === "Tab") ||
      ["ArrowUp", "ArrowDown"].includes(event.key) ||
      (!custom && active >= 0 && ["ArrowLeft", "ArrowRight"].includes(event.key))
    ) {
      event.preventDefault();
      navigate(event.shiftKey || ["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1);
    } else if (event.key === "Enter" && (custom || !event.shiftKey)) {
      event.preventDefault();
      if (custom && (event.ctrlKey || event.metaKey)) {
        snooze();
        void respond(draft.answers);
      } else if (custom || question.multiSelect || active < 0) advance(withFocusedOption());
      else choose(active);
    } else if (event.key === " " && !custom && active >= 0) {
      event.preventDefault();
      choose(active);
    }
  };
  const longQuestion = question.question.length > 80 || question.question.includes("\n");
  const countdown = remaining > 0 && remaining < 60 && (
    <button className="question-countdown" aria-label="停止计时" title="停止计时" onClick={snooze}>
      {remaining}秒
    </button>
  );
  const collapseLabel = dialogExpanded ? "折叠问题弹窗" : "展开问题弹窗";
  return (
    <div
      ref={card}
      role="dialog"
      aria-label="回答助手问题"
      tabIndex={active < 0 ? 0 : -1}
      className="user-question-card"
      data-expanded={dialogExpanded}
      onKeyDown={onKey}
      onMouseEnter={snooze}
    >
      <div className="question-scroll-body">
        <div className="user-question-heading">
          <div>
            {question.header && <span className="question-badge">{question.header}</span>}
            <span
              className={`question-title${longQuestion && !questionExpanded ? " question-clamped" : ""}`}
              title={question.question}
            >
              {question.question}
            </span>
            {longQuestion && (
              <button
                className="question-expand-text"
                aria-expanded={questionExpanded}
                onClick={() => setQuestionExpanded(!questionExpanded)}
              >
                {questionExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {questionExpanded ? "收起问题" : "展开问题"}
              </button>
            )}
          </div>
          <nav aria-label="问题导航">
            {countdown}
            <button
              className="question-collapse"
              aria-label={collapseLabel}
              aria-expanded={dialogExpanded}
              title={collapseLabel}
              onClick={() => setDialogExpanded(!dialogExpanded)}
            >
              {dialogExpanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
            </button>
            <button
              aria-label="上一题"
              disabled={draft.index === 0 || sending}
              onClick={() => move(draft.index - 1)}
            >
              <ChevronLeft size={12} />
            </button>
            <span>
              {draft.index + 1} / {request.questions.length}
            </span>
            <button
              aria-label="下一题"
              disabled={draft.index === request.questions.length - 1 || sending}
              onClick={() => advance(withFocusedOption())}
            >
              <ChevronRight size={12} />
            </button>
          </nav>
        </div>
        <div className="question-body">
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Choice group switches between ZCode single-select and multi-select semantics. */}
          <div
            className="question-options"
            role={question.multiSelect ? "group" : "listbox"}
            aria-label={question.question}
          >
            {question.options.map((option, index) => (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Options switch between checkbox and option roles with matching state attributes.
              <button
                key={option.label}
                aria-label={`${option.label}${option.description ? ` ${option.description}` : ""}`}
                data-question-option={index}
                role={question.multiSelect ? "checkbox" : "option"}
                aria-checked={question.multiSelect ? answer.selected.includes(option.label) : undefined}
                aria-selected={!question.multiSelect ? answer.selected.includes(option.label) : undefined}
                tabIndex={active === index || (active < 0 && index === 0) ? 0 : -1}
                disabled={sending}
                data-active={index === active}
                data-selected={answer.selected.includes(option.label)}
                onFocus={() => setActive(index)}
                onClick={() => choose(index)}
              >
                {question.multiSelect ? (
                  <span className="question-checkbox">
                    <Check size={12} />
                  </span>
                ) : (
                  <span className="question-number">{index + 1}.</span>
                )}
                <span className="question-option-copy">
                  <strong>{option.label}</strong>
                  {option.description && (
                    <span className="question-option-description">{option.description}</span>
                  )}
                </span>
              </button>
            ))}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: The textarea owns keyboard interaction; clicking its row focuses it. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: The textarea owns keyboard interaction. */}
            {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: The custom row uses checkbox state only for multi-select questions. */}
            <div
              className="question-custom"
              role={question.multiSelect ? "checkbox" : undefined}
              aria-checked={question.multiSelect ? Boolean(answer.custom.trim()) : undefined}
              aria-label={question.multiSelect ? "自定义回答选项" : undefined}
              data-active={active === question.options.length}
              data-selected={Boolean(answer.custom.trim())}
              onClick={() => card.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus()}
            >
              {question.multiSelect ? (
                <span className="question-checkbox">
                  <Check size={12} />
                </span>
              ) : (
                <span className="question-number">{question.options.length + 1}.</span>
              )}
              <textarea
                rows={1}
                aria-label="自定义回答"
                placeholder="输入你的回答..."
                value={answer.custom}
                disabled={sending}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                data-question-option={question.options.length}
                onFocus={() => setActive(question.options.length)}
                onChange={(event) => {
                  snooze();
                  update({
                    ...draft,
                    answers: draft.answers.map((value, index) =>
                      index === draft.index
                        ? { selected: question.multiSelect ? value.selected : [], custom: event.target.value }
                        : value,
                    ),
                  });
                }}
              />
            </div>
          </div>
        </div>
        {error && (
          <p role="alert" className="run-error">
            {error}
          </p>
        )}
      </div>
      {!dialogExpanded && (
        <div className="question-collapsed-summary">
          <button onClick={() => setDialogExpanded(true)}>
            {question.header && <span className="question-badge">{question.header}</span>}
            <span>{question.question}</span>
          </button>
          {countdown}
          <span>
            {draft.index + 1} / {request.questions.length}
          </span>
          <button aria-label={collapseLabel} aria-expanded={false} onClick={() => setDialogExpanded(true)}>
            <ChevronUp size={12} />
          </button>
        </div>
      )}
      <footer>
        <p>
          <Info size={16} />
          <span>使用 Tab / 上下键选择，回车或空格选中</span>
        </p>
        <div>
          <button disabled={sending} onClick={() => void respond([], true)}>
            忽略
          </button>
          <button className="primary" disabled={sending} onClick={() => advance(withFocusedOption())}>
            {draft.index === request.questions.length - 1 ? "提交" : "继续"}
          </button>
        </div>
      </footer>
    </div>
  );
}
