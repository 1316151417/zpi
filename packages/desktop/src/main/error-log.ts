import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const maxErrorLogBytes = 5 * 1024 * 1024;
type Context = Record<string, string | number | boolean | undefined>;

function redact(value: string): string {
  return value
    .replace(/(data:[\w.+/-]+(?:;[\w=.+-]+)*,)[^\s"'<>)]*/gi, "$1[OMITTED]")
    .replace(/\b(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED]")
    .replace(
      /(["']?(?:api[_ -]?key(?: provided)?|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|cookie|password|client_secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/([?&](?:code|state)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 32_000);
}

/** Synchronous, best-effort writes also retain errors immediately before a process exits. */
export class ErrorLog {
  readonly path: string;
  private reportedFailure = false;
  private context: Context;

  constructor(dataDir: string, context: Context = {}) {
    this.path = join(dataDir, "agent", "logs", "error.log");
    this.context = context;
    this.safely(() => {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, "", { mode: 0o600 });
    });
  }

  write(source: string, error: unknown, context: Context = {}): void {
    this.safely(() => {
      const details =
        error && typeof error === "object" ? (error as { message?: unknown; stack?: unknown }) : undefined;
      const message = typeof details?.message === "string" ? details.message : String(error);
      const fields = Object.fromEntries(
        Object.entries({ ...this.context, ...context }).map(([key, value]) => [
          key,
          typeof value === "string" ? redact(value) : value,
        ]),
      );
      const entry = `${JSON.stringify({
        time: new Date().toISOString(),
        source: redact(source),
        ...fields,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        message: redact(message),
        ...(typeof details?.stack === "string" ? { stack: redact(details.stack) } : {}),
      })}\n`;
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = statSync(this.path).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (size && size + Buffer.byteLength(entry) > maxErrorLogBytes) renameSync(this.path, `${this.path}.1`);
      appendFileSync(this.path, entry, { mode: 0o600 });
    });
  }

  private safely(action: () => void): void {
    try {
      action();
    } catch {
      if (this.reportedFailure) return;
      this.reportedFailure = true;
      try {
        process.stderr.write(`ZPI could not write the error log: ${this.path}\n`);
      } catch {
        // Logging must never cause another application failure.
      }
    }
  }
}
