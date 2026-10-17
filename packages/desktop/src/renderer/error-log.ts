export function logRendererError(source: string, error: unknown): void {
  try {
    const messages: string[] = [];
    const stacks: string[] = [];
    const seen = new Set<unknown>();
    let current = error;
    while (current != null && !seen.has(current) && seen.size < 5) {
      seen.add(current);
      const details =
        typeof current === "object"
          ? (current as { message?: unknown; stack?: unknown; cause?: unknown })
          : undefined;
      messages.push(typeof details?.message === "string" ? details.message : String(current));
      if (typeof details?.stack === "string") stacks.push(details.stack);
      current = details?.cause;
    }
    window.zpi.logError({
      source,
      message: (messages.join("\nCaused by: ") || String(error)).slice(0, 32_000),
      ...(stacks.length ? { stack: stacks.join("\nCaused by: ").slice(0, 32_000) } : {}),
    });
  } catch {
    // The original error remains visible even if the bridge is unavailable.
  }
}
