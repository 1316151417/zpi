// AskUserQuestion schema and answer semantics follow ZCode (Apache-2.0).
import type { ToolDefinition } from "ZPI-coding-agent";
import type { UserQuestionRequest, UserQuestionResponse } from "ZPI-ui";
import { Type } from "typebox";
import { Value } from "typebox/value";

const parameters = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          question: Type.String({ minLength: 1, maxLength: 8000 }),
          header: Type.String({ minLength: 1, maxLength: 12 }),
          options: Type.Array(
            Type.Object(
              {
                label: Type.String({ minLength: 1, maxLength: 200 }),
                description: Type.String({ maxLength: 8000 }),
                preview: Type.Optional(Type.String({ maxLength: 16000 })),
              },
              { additionalProperties: false },
            ),
            { minItems: 2, maxItems: 4 },
          ),
          multiSelect: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 4 },
    ),
  },
  { additionalProperties: false },
);

interface PendingQuestion {
  request: UserQuestionRequest;
  resolve: (response: UserQuestionResponse) => void;
  timers: ReturnType<typeof setTimeout>[];
}
export class UserQuestions {
  private pending = new Map<string, PendingQuestion>();
  private autoResolutionEnabled = true;
  private publish: (sessionId: string, request: UserQuestionRequest | null) => void;
  constructor(publish: (sessionId: string, request: UserQuestionRequest | null) => void) {
    this.publish = publish;
  }
  get(sessionId: string) {
    return this.pending.get(sessionId)?.request ?? null;
  }
  setAutoResolutionEnabled(enabled: boolean) {
    this.autoResolutionEnabled = enabled;
    if (!enabled) for (const [id, pending] of this.pending) this.snooze(id, pending.request.id);
  }
  snooze(sessionId: string, requestId: string) {
    const pending = this.pending.get(sessionId);
    const state = pending?.request.autoResolution;
    if (!pending || pending.request.id !== requestId || !state || state.phase === "snoozed") return;
    for (const timer of pending.timers) clearTimeout(timer);
    pending.timers = [];
    pending.request = {
      ...pending.request,
      autoResolution: { phase: "snoozed", startedAt: state.startedAt, snoozedAt: Date.now() },
    };
    this.publish(sessionId, pending.request);
  }
  respond(sessionId: string, requestId: string, response: UserQuestionResponse) {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.request.id !== requestId) throw new Error("not_found: 提问已结束");
    if (!response?.answers || typeof response.answers !== "object" || Array.isArray(response.answers))
      throw new Error("invalid_input: 无效回答");
    const questions = new Set(pending.request.questions.map((q) => q.question));
    if (
      Object.entries(response.answers).some(
        ([key, value]) => !questions.has(key) || typeof value !== "string" || value.length > 16000,
      )
    )
      throw new Error("invalid_input: 无效回答");
    if (
      response.annotations &&
      (typeof response.annotations !== "object" ||
        Array.isArray(response.annotations) ||
        Object.entries(response.annotations).some(
          ([key, value]) =>
            !questions.has(key) ||
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.entries(value).some(
              ([field, text]) =>
                !["preview", "notes"].includes(field) || typeof text !== "string" || text.length > 16000,
            ),
        ))
    )
      throw new Error("invalid_input: 无效回答备注");
    pending.resolve(structuredClone(response));
  }
  tool(sessionId: string): ToolDefinition<typeof parameters> {
    return {
      name: "AskUserQuestion",
      label: "提问",
      description: [
        "Use this tool only when blocked on a decision that is the user's to make and cannot be resolved from the request, code, or sensible defaults.",
        "Ask 1-4 questions with 2-4 options each. Users can always provide custom text. Do not include an Other option.",
        "Use multiSelect: true for multiple choices. Put a recommended option first and suffix its label with (Recommended).",
        "Use optional preview text for concrete artifacts, code or Markdown mockups to compare; previews apply to single-select questions.",
        "The tool waits for user answers. Skipped questions have no answer; continue using best judgment without inventing preferences.",
      ].join("\n"),
      parameters,
      executionMode: "sequential",
      requiresUserInteraction: true,
      prepareArguments: (args) => {
        const value = structuredClone(args) as { questions?: { multiSelect?: boolean }[] };
        // ZCode defaults omitted multiSelect to false while advertising it as required to providers.
        if (Array.isArray(value?.questions))
          for (const question of value.questions) question.multiSelect ??= false;
        if (!Value.Check(parameters, value)) throw new Error("Invalid AskUserQuestion arguments");
        const parsed = value as unknown as Pick<UserQuestionRequest, "questions">;
        if (new Set(parsed.questions.map((q) => q.question)).size !== parsed.questions.length)
          throw new Error("Question texts must be unique");
        for (const question of parsed.questions) {
          if (
            new Set(question.options.map((option) => option.label)).size !== question.options.length ||
            question.options.some((option) => option.label.trim().toLowerCase() === "other")
          )
            throw new Error("Option labels must be unique and must not include Other");
        }
        return parsed;
      },
      execute: async (id, params, signal) => {
        if (signal?.aborted) throw new Error("AskUserQuestion cancelled");
        if (this.pending.has(sessionId)) throw new Error("A question is already pending");
        const startedAt = Date.now();
        const request: UserQuestionRequest = {
          id,
          questions: params.questions,
          ...(this.autoResolutionEnabled
            ? {
                autoResolution: {
                  phase: "hiddenGrace",
                  startedAt,
                  visibleAt: startedAt + 60_000,
                  deadlineAt: startedAt + 300_000,
                } as const,
              }
            : {}),
        };
        let cancel = () => {};
        let autoResolved = false;
        try {
          const response = await new Promise<UserQuestionResponse>((resolve, reject) => {
            cancel = () => reject(new Error("AskUserQuestion cancelled"));
            const pending: PendingQuestion = { request, resolve, timers: [] };
            this.pending.set(sessionId, pending);
            if (request.autoResolution && request.autoResolution.phase !== "snoozed") {
              pending.timers.push(
                setTimeout(() => {
                  const state = pending.request.autoResolution;
                  if (!state || state.phase === "snoozed") return;
                  pending.request = {
                    ...pending.request,
                    autoResolution: { ...state, phase: "visibleCountdown" },
                  };
                  this.publish(sessionId, pending.request);
                }, 60_000),
              );
              pending.timers.push(
                setTimeout(() => {
                  autoResolved = true;
                  pending.resolve({ answers: {} });
                }, 300_000),
              );
            }
            signal?.addEventListener("abort", cancel, { once: true });
            this.publish(sessionId, request);
          });
          const count = Object.keys(response.answers).length;
          const text = count
            ? `User answers: ${JSON.stringify(response)}. Use best judgment for any skipped questions.`
            : `The user did not provide answers${autoResolved ? " within five minutes" : ""}. Continue using your best judgment; do not treat this as rejection or invent a preference.`;
          return {
            content: [{ type: "text", text }],
            details: JSON.parse(
              JSON.stringify({
                questions: params.questions,
                ...response,
                ...(autoResolved ? { autoResolved: true } : {}),
              }),
            ),
          };
        } finally {
          signal?.removeEventListener("abort", cancel);
          for (const timer of this.pending.get(sessionId)?.timers ?? []) clearTimeout(timer);
          this.pending.delete(sessionId);
          this.publish(sessionId, null);
        }
      },
    };
  }
}
