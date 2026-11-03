import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

for (const side of [false, true]) {
  for (const action of ["queue-now", "modified-enter"] as const) {
    test(`immediate send preempts a stalled stream and drains remaining inputs once (${side ? "side" : "main"}, ${action})`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "zpi-immediate-send-"));
      const cwd = join(dir, "workspace");
      await mkdir(cwd);
      const mainId = seedHistory(dir, cwd, 1).id;
      const release = deferred();
      const server = await fakeServer(async (body, response) => {
        const user = (body.messages as unknown as { role: string; content: string }[])
          .filter((m) => m.role === "user")
          .at(-1)?.content;
        if (user === "hold waiting") {
          if (action === "modified-enter") send(response, chunk({ content: "Original partial remains." }));
          else response.flushHeaders();
          await release.promise;
        }
        if (!response.destroyed) {
          send(response, chunk({ content: "Replacement received." }));
          done(response);
        }
      });
      let app: ElectronApplication | undefined;
      try {
        app = await launchDesktop({ dir, url: server.url });
        const page = await app.firstWindow();
        if (side) {
          await page.getByLabel("展开右侧栏", { exact: true }).click();
          await page
            .locator(".pane-empty-launcher")
            .getByRole("button", { name: "辅助对话", exact: true })
            .click();
        }
        const scope = page.locator(side ? ".side-chat-pane" : "main");
        const sessionId = side ? await scope.getAttribute("data-side-chat-session") : mainId;
        if (!sessionId) throw new Error("Missing session ID");
        const editor = scope.getByLabel("消息", { exact: true });
        await editor.fill("hold waiting");
        await editor.press("Enter");
        await expect.poll(() => server.requests.length).toBe(1);
        const runId = await scope.getByTestId("run").last().getAttribute("data-run-id");
        expect(runId).toBeTruthy();
        const original = scope.locator(`[data-run-id="${runId}"]`);
        if (action === "modified-enter")
          await expect(original.locator(".answer")).toHaveText("Original partial remains.");
        for (const text of action === "queue-now"
          ? ["queued before", "immediate replacement", "queued after"]
          : ["queued before", "queued after"]) {
          await editor.fill(text);
          await editor.press("Enter");
        }
        expect(server.requests).toHaveLength(1);
        if (action === "queue-now") {
          await scope
            .getByTestId("queue-item")
            .filter({ hasText: "immediate replacement" })
            .getByRole("button", { name: "立即", exact: true })
            .click();
        } else {
          await editor.fill("immediate replacement");
          await editor.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Enter`);
        }
        // The original response is still gated: progress must come from cancellation,
        // not from waiting for its next model/tool boundary.
        await expect(original).toHaveAttribute("data-status", "aborted");
        await expect(scope.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
        await expect(scope.getByTestId("queue-item")).toHaveCount(0);
        await expect.poll(() => server.requests.length).toBe(4);
        expect(
          server.requests.map(
            (request) =>
              (request.messages as unknown as { role: string; content: string }[])
                .filter((m) => m.role === "user")
                .at(-1)?.content,
          ),
        ).toEqual(["hold waiting", "immediate replacement", "queued before", "queued after"]);
        // Every replacement is a separate run; no user-facing immediate input is
        // silently stored as a guide on the aborted run.
        await expect(scope.locator(".guide-message")).toHaveCount(0);
        const ids = await scope
          .getByTestId("run")
          .evaluateAll((runs) => runs.map((run) => run.getAttribute("data-run-id")));
        expect(new Set(ids).size).toBe(ids.length);
        if (action === "modified-enter")
          await expect(original.locator(".answer")).toHaveText("Original partial remains.");
        await app.close();
        app = await launchDesktop({ dir, url: server.url });
        const restoredPage = await app.firstWindow();
        // Auxiliary tabs are transient; verify their durable history through the host.
        const restored = await restoredPage.evaluate((id) => window.zpi.getSessionSnapshot(id), sessionId);
        if (!restored.ok) throw new Error(restored.error.message);
        expect(restored.value.view.runs.find((run) => run.runId === runId)?.status).toBe("aborted");
        expect(
          restored.value.view.runs.filter((run) => run.userMessage === "immediate replacement"),
        ).toHaveLength(1);
        expect(restored.value.view.queue?.items ?? []).toHaveLength(0);
        if (!side)
          await expect(restoredPage.locator(`[data-run-id="${runId}"]`)).toHaveAttribute(
            "data-status",
            "aborted",
          );
        expect(server.requests).toHaveLength(4);
      } finally {
        release.resolve();
        await runCleanup([() => rm(dir, { recursive: true, force: true }), server.close, () => app?.close()]);
      }
    });
  }
}
