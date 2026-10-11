import { LucideProvider } from "lucide-react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startAppearance } from "./appearance.ts";
import { logRendererError } from "./error-log.ts";
import "zpi-ui/styles.css";
import "./workbench.css";

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
window.addEventListener("beforeunload", stopAppearance, { once: true });

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
// ZCode Root supplies this default to navigation, settings and portal menus.
createRoot(root).render(
  <LucideProvider strokeWidth={1.5}>
    <App />
  </LucideProvider>,
);
