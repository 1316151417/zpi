import { type ReactNode, useEffect, useState } from "react";

const shown = new Set<string>();

// Live tools fade in once; history and task switches must not replay the entrance.
export function StreamEntrance({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  const [animate] = useState(() => active && !shown.has(id));
  useEffect(() => {
    if (!animate) return;
    shown.add(id);
    const oldest = shown.values().next().value;
    if (shown.size > 2000 && oldest !== undefined) shown.delete(oldest);
  }, [animate, id]);
  return <div data-stream-entrance={animate || undefined}>{children}</div>;
}
