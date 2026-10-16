import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { observeAppearance } from "zpi-ui";
import type { TerminalProfile } from "../shared/bridge.ts";
import { openBrowser, paneTask, terminalListeners, terminalOutput } from "./pane-store.ts";
import { report, unwrap } from "./store.ts";
import { terminalCssColor, terminalOptions, terminalTheme } from "./terminal-presentation.ts";
export function TerminalPane({
  id,
  sessionId,
  visible,
  cwd,
  profile,
}: {
  id: string;
  sessionId: string;
  visible: boolean;
  cwd: string;
  profile?: TerminalProfile;
}) {
  const root = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | undefined>(undefined),
    fit = useRef<FitAddon | undefined>(undefined);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const openLink = (event: MouseEvent, url: string) => {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) paneTask(openBrowser(url, sessionId));
    };
    const term = new Terminal({
      ...terminalOptions(profile),
      linkHandler: { allowNonHttpProtocols: false, activate: openLink },
    });
    const fitting = new FitAddon();
    terminal.current = term;
    fit.current = fitting;
    term.loadAddon(fitting);
    term.loadAddon(new WebLinksAddon(openLink));
    term.open(element);
    term.write(terminalOutput.get(id) ?? "");
    terminalListeners.set(id, (event) => term.write(event.data));
    const input = term.onData((data) => paneTask(window.zpi.terminalInput(id, data).then(unwrap)));
    const resize = term.onResize(({ cols, rows }) =>
      paneTask(window.zpi.resizeTerminal(id, cols, rows).then(unwrap)),
    );
    let frame = 0;
    const fitSize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (element.clientWidth && element.clientHeight) fitting.fit();
      });
    };
    const observer = new ResizeObserver(fitSize);
    observer.observe(element);
    const theme = () => {
      const styles = getComputedStyle(document.documentElement);
      const dark = document.documentElement.dataset.theme === "dark";
      term.options.theme = terminalTheme(
        dark,
        terminalCssColor(styles, "--color-bg", dark ? "#161616" : "#f8f8f8"),
        terminalCssColor(styles, "--color-text", dark ? "#d4d4d4" : "#262626"),
        profile,
      );
      fitSize();
    };
    theme();
    const unsubscribeAppearance = observeAppearance(theme);
    fitSize();
    const copy = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && term.hasSelection()) {
        event.preventDefault();
        void window.zpi.copyText(term.getSelection()).then(unwrap).catch(report);
      }
    };
    term.attachCustomKeyEventHandler((event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && term.hasSelection()) {
        copy(event);
        return false;
      }
      return true;
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      input.dispose();
      resize.dispose();
      terminalListeners.delete(id);
      unsubscribeAppearance();
      term.dispose();
      terminal.current = undefined;
      fit.current = undefined;
    };
  }, [id, sessionId, profile]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      fit.current?.fit();
      if (!document.querySelector('dialog[open], [role="dialog"], [role="menu"], .settings-screen'))
        terminal.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [id, visible]);
  return (
    <div className="terminal-pane" title={cwd}>
      <div ref={root} className="terminal-surface" data-testid="terminal-surface" />
    </div>
  );
}
