import { LucideProvider } from "lucide-react";
import { createRoot } from "react-dom/client";
import { AppBoundary } from "./AppBoundary.tsx";
import { startRendererPerformanceDiagnostics } from "./performance-diagnostics.ts";
import "zpi-ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");

async function startRenderer(root: HTMLElement) {
  const [{ App }, { startAppearance }, { logRendererError }, { DiffsWorkerPool }] = await Promise.all([
    import("./App.tsx"),
    import("./appearance.ts"),
    import("./error-log.ts"),
    import("./DiffsWorkerPool.tsx"),
    import("./workbench.css"),
  ]);
  window.addEventListener("error", (event) => {
    logRendererError(
      "uncaught",
      event.error ?? `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
    );
  });
  window.addEventListener("unhandledrejection", (event) =>
    logRendererError("unhandled-rejection", event.reason),
  );
  const stopAppearance = startAppearance();
  const stopPerformance = startRendererPerformanceDiagnostics();
  window.addEventListener(
    "beforeunload",
    () => {
      stopAppearance();
      stopPerformance();
    },
    { once: true },
  );
  // ZCode Root supplies this default to navigation, settings and portal menus.
  createRoot(root).render(
    <AppBoundary>
      <LucideProvider strokeWidth={1.5}>
        <DiffsWorkerPool>
          <App />
        </DiffsWorkerPool>
      </LucideProvider>
    </AppBoundary>,
  );
}

void startRenderer(root).catch((error) => {
  console.error(error);
  root.textContent = "无法加载窗口，请重启 ZPI。";
});
