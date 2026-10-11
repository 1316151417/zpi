// Adapted from ZCode ToolCallBlocks/renderers/ask-question.tsx (Apache-2.0).
import { CircleHelp } from "lucide-react";
import type { ToolBlockProps } from "./ToolBlock.tsx";
import { ToolFailure } from "./ToolFailure.tsx";
import { ToolLayout } from "./ToolLayout.tsx";
import { questionPresentation } from "./user-question-presentation.ts";

export function AskQuestionToolBlock({ block, expanded, toggle, showIcon, onCopy }: ToolBlockProps) {
  const presentation = questionPresentation(block);
  return (
    <div className="tool-block" data-testid="tool-block" data-tool-name={block.name}>
      <ToolLayout
        icon={CircleHelp}
        label={presentation.running ? "正在询问" : "已询问"}
        running={presentation.running}
        showIcon={showIcon}
        expanded={!presentation.running && expanded}
        toggle={presentation.running ? undefined : toggle}
        secondary={presentation.running ? undefined : presentation.summary}
        title="AskUserQuestion"
        failure={block.status === "error" ? <ToolFailure text={block.output} onCopy={onCopy} /> : undefined}
        content={
          <div
            className="question-tool-answers"
            data-conversation-selectable="tool"
            data-selection-key={block.id}
          >
            {presentation.questions.length ? (
              presentation.questions.map(({ id, question, answer }) => (
                <div key={id}>
                  <p className="question-tool-question">{question}</p>
                  <p>{answer}</p>
                </div>
              ))
            ) : (
              <p>{presentation.noAnswer}</p>
            )}
          </div>
        }
      />
    </div>
  );
}
