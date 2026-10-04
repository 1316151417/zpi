import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { observeAppearance } from "zpi-ui";
import { openBrowser, paneTask, terminalListeners, terminalOutput } from "./pane-store.ts";
import { report, unwrap } from "./store.ts";
export function TerminalPane({ id, visible, cwd }: { id: string; visible: boolean; cwd: string }) {
  const root = useRef<HTMLDivElement>(null),
    fit = useRef<FitAddon | undefined>(undefined);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"SFMono-Regular", Menlo, monospace',
      scrollback: 5000,
      allowProposedApi: false,
    });
    const fitting = new FitAddon();
    fit.current = fitting;
    term.loadAddon(fitting);
    term.loadAddon(
      new WebLinksAddon((event, url) => {
        event.preventDefault();
        paneTask(openBrowser(url));
      }),
    );
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
      term.options.theme = {
        background: styles.getPropertyValue("--color-bg").trim(),
        foreground: styles.getPropertyValue("--color-text").trim(),
        cursor: styles.getPropertyValue("--color-text").trim(),
        selectionBackground: styles.getPropertyValue("--color-terminal-selection").trim(),
      };
      term.options.fontSize = Number.parseFloat(styles.getPropertyValue("--ui-font-size")) - 2;
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
      fit.current = undefined;
    };
  }, [id]);
  useEffect(() => {
    if (visible) requestAnimationFrame(() => fit.current?.fit());
  }, [visible]);
  return (
    <div className="terminal-pane" title={cwd}>
      <div className="terminal-cwd">{cwd}</div>
      <div ref={root} className="terminal-surface" data-testid="terminal-surface" />
    </div>
  );
}
