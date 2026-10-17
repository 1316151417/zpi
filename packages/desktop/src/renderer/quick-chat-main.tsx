import { LucideProvider } from "lucide-react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "zpi-ui/styles.css";
import { QuickChat } from "./QuickChat.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
// Mount the editable input before the module/load event completes; no model or snapshot wait.
flushSync(() =>
  createRoot(root).render(
    <LucideProvider strokeWidth={1.5}>
      <QuickChat />
    </LucideProvider>,
  ),
);
