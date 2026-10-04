import { useEffect, useState } from "react";

// ZCode ConversationDraftEmptyState greeting and responsive typography.
export function DraftGreeting() {
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = window.setInterval(() => setHour(new Date().getHours()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const greeting =
    hour >= 5 && hour < 9
      ? "早上好呀，新的一天开始啦"
      : hour < 12 && hour >= 9
        ? "上午好呀，有什么想让我帮忙的吗"
        : hour < 14 && hour >= 12
          ? "中午好呀，要不要先休息一下"
          : hour < 18 && hour >= 14
            ? "下午好呀，接下来交给我吧"
            : hour < 23 && hour >= 18
              ? "晚上好呀，今天辛苦啦"
              : "夜深啦，别忘了照顾好自己哦";
  return <h1 className="draft-greeting">{greeting}</h1>;
}
