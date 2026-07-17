import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export function XtermPanel({
  output,
  running,
  onInput,
  onResize,
}: {
  output: string;
  running: boolean;
  onInput: (value: string) => void;
  onResize: (columns: number, rows: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const renderedLengthRef = useRef(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 100_000,
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
      fontSize: 11,
      lineHeight: 1.35,
      theme: { background: "#0b0d0f", foreground: "#b7d6af", cursor: "#a7e26f", selectionBackground: "#34432c" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    const data = terminal.onData((value) => onInput(value));
    const resize = new ResizeObserver(() => {
      fit.fit();
      onResize(terminal.cols, terminal.rows);
    });
    resize.observe(hostRef.current);
    terminalRef.current = terminal;
    return () => {
      resize.disconnect();
      data.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [onInput, onResize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (output.length < renderedLengthRef.current) {
      terminal.clear();
      renderedLengthRef.current = 0;
    }
    const delta = output.slice(renderedLengthRef.current);
    if (delta) terminal.write(delta.replace(/\n/g, "\r\n"));
    renderedLengthRef.current = output.length;
  }, [output]);

  useEffect(() => {
    if (running) terminalRef.current?.focus();
  }, [running]);

  return <div ref={hostRef} className="xterm-host" />;
}
