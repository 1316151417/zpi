export async function refreshTaskGroupChangeSummary(
  inFlight: { current: boolean },
  query: () => Promise<{ added: number; removed: number }[]>,
  publish: (summary: { added: number; removed: number }) => void,
): Promise<void> {
  if (inFlight.current) return;
  inFlight.current = true;
  try {
    const changes = await query();
    publish(
      changes.reduce(
        (sum, item) => ({ added: sum.added + item.added, removed: sum.removed + item.removed }),
        { added: 0, removed: 0 },
      ),
    );
  } finally {
    // The next hover must reread live changes, including after a failed request.
    inFlight.current = false;
  }
}
