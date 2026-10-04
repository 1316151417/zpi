import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startAppearance } from "./appearance.ts";
import "zpi-ui/styles.css";
import "./workbench.css";

const stopAppearance = startAppearance();
window.addEventListener("beforeunload", stopAppearance, { once: true });

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App />);
