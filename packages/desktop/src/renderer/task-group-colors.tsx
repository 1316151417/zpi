import { Hash } from "lucide-react";
import type { TaskGroupColor } from "../shared/task-groups.ts";
export const groupColorLabels: Record<TaskGroupColor, string> = {
  gray: "灰色",
  red: "红色",
  orange: "橙色",
  yellow: "黄色",
  green: "绿色",
  blue: "蓝色",
  purple: "紫色",
};
export function TaskGroupColorMark({ color, dot = false }: { color: TaskGroupColor; dot?: boolean }) {
  return (
    <span className={dot ? "task-group-color-dot" : "task-group-color-mark"} data-group-color={color}>
      {!dot && <Hash size={12} />}
    </span>
  );
}
