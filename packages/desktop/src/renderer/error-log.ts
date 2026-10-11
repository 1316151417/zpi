export function logRendererError(source: string, error: unknown): void {
  try {
    const details =
      error && typeof error === "object" ? (error as { message?: unknown; stack?: unknown }) : undefined;
    window.zpi.logError({
      source,
      message: (typeof details?.message === "string" ? details.message : String(error)).slice(0, 32_000),
      ...(typeof details?.stack === "string" ? { stack: details.stack.slice(0, 32_000) } : {}),
    });
  } catch {
    // The original error remains visible even if the bridge is unavailable.
  }
}
