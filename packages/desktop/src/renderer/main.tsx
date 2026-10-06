import { LucideProvider } from "lucide-react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startAppearance } from "./appearance.ts";
import { logRendererError } from "./error-log.ts";
import "ZPI-ui/styles.css";
import "./workbench.css";

// Preserve local UI preferences written before the brand names were unified.
for (const key of Object.keys(localStorage)) {
  const canonical = key.replace(/^ZPI(?=[.:-])/i, "ZPI");
  if (canonical !== key) {
    const value = localStorage.getItem(key);
    if (value !== null && localStorage.getItem(canonical) === null) localStorage.setItem(canonical, value);
    localStorage.removeItem(key);
  }
}

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
