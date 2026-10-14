/** Synthetic temporary data only. Measures disposable disk-spooled offline migration. */
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convert, inspect } from "./storage-migration/workflow.ts";

const sourceMiB = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(sourceMiB) || sourceMiB < 1) throw new Error("positive integer MiB required");
const role = process.argv[3] ?? "user";
if (role !== "user" && role !== "system") throw new Error("role must be user or system");
const root = await mkdtemp(join(tmpdir(), "zpi-migration-bench-"));
try {
  const source = join(root, "source");
  await mkdir(join(source, "agent/sessions/_unassigned"), { recursive: true });
  const file = await open(join(source, "agent/sessions/_unassigned/large.jsonl"), "wx");
  const timestamp = "2026-01-01T00:00:00.000Z";
  await file.writeFile(
    `${JSON.stringify({ type: "session", version: 1, format: "zpi", id: "large", cwd: "/external", timestamp })}\n`,
  );
  const content = "x".repeat(1024 * 1024);
  for (let i = 0; i < sourceMiB; i++)
    await file.writeFile(
      `${JSON.stringify({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp, message: { role, content, timestamp: 1 } })}\n`,
    );
  await file.close();
  const start = performance.now();
  const plan = await inspect(source);
  const inspected = performance.now();
  await convert(plan, join(root, "target"), true);
  console.log(
    JSON.stringify({
      sourceMiB,
      role,
      node: process.version,
      inspectMs: inspected - start,
      convertValidateMs: performance.now() - inspected,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
