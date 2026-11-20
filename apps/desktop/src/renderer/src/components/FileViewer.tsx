import { useEffect, useMemo, useState } from "react";
import { Check, Code2, Copy, Download, Eye, ExternalLink, FileText, X } from "lucide-react";
import { copyText } from "../lib/copy";
import { formatBytes } from "../lib/files";
import { useStore, type ViewerTarget } from "../lib/store";
import { Markdown } from "./Markdown";

/** Biggest text file the viewer reads into the page; bigger ones get Download / Open in browser. */
const MAX_TEXT_BYTES = 3 * 1024 * 1024;
const MAX_CSV_ROWS = 1000;

type Kind = "markdown" | "html" | "image" | "pdf" | "csv" | "text" | "other";

const EXT_KIND: Record<string, Kind> = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  html: "html", htm: "html",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image", avif: "image",
  pdf: "pdf",
  csv: "csv", tsv: "csv",
};
const TEXT_EXT = new Set(
  "txt text log sh bash zsh fish ps1 py rb php js mjs cjs jsx ts mts cts tsx json jsonl yaml yml toml ini cfg conf env properties sql tf tfvars hcl go rs java kt kts swift c h cc cpp hpp cs lua r pl css scss less xml diff patch gitignore dockerfile makefile mk gradle vue svelte".split(" "),
);

export function kindOf(name: string, mimeType?: string): Kind {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  if (TEXT_EXT.has(ext)) return "text";
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType === "text/html") return "html";
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType?.startsWith("text/") || mimeType === "application/json") return "text";
  return "other";
}

/** Splits CSV/TSV, honouring quoted fields ("a, b" and "" escapes). */
function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length > MAX_CSV_ROWS) break;
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

/** Shows a file a Bot made (or one you attached) inside Cadre: Markdown rendered, HTML pages, code, tables, images, PDFs. */
export function FileViewer() {
  const target = useStore((s) => s.viewer);
  const close = useStore((s) => s.closeViewer);
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target, close]);
  if (!target) return null;
  return <ViewerBody key={target.url} target={target} onClose={close} />;
}

function ViewerBody({ target, onClose }: { target: ViewerTarget; onClose: () => void }) {
  const kind = kindOf(target.name, target.mimeType);
  const needsText = kind === "markdown" || kind === "csv" || kind === "text" || kind === "html";
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!needsText) return;
    if (target.size !== undefined && target.size > MAX_TEXT_BYTES) {
      setError(`This file is ${formatBytes(target.size)}, too big to show here.`);
      return;
    }
    const ac = new AbortController();
    fetch(target.url, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "This file isn't there any more." : `Couldn't load it (${r.status}).`);
        const len = Number(r.headers.get("content-length") ?? 0);
        if (len > MAX_TEXT_BYTES) throw new Error(`This file is ${formatBytes(len)}, too big to show here.`);
        setText(await r.text());
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ac.abort();
  }, [target.url, target.size, needsText]);

  const rows = useMemo(() => (kind === "csv" && text !== null ? parseDelimited(text, target.name.toLowerCase().endsWith(".tsv") ? "\t" : ",") : null), [kind, text, target.name]);
  const canToggle = kind === "markdown" || kind === "html" || kind === "csv";
  const showSource = canToggle && source;

  const copy = async () => {
    if (text !== null && (await copyText(text))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const btn = "flex items-center gap-1 rounded-app border border-line px-2 py-1 text-[13px] hover:bg-sunken";
  return (
    <div className="fixed inset-0 z-50 flex bg-black/50 md:p-[3%]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex min-h-0 w-full flex-col overflow-hidden bg-bg shadow-2xl md:rounded-app md:border md:border-line" role="dialog" aria-label={target.name}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 md:px-4">
          <FileText size={16} className="shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-medium">{target.name}</div>
            {(target.path || target.size !== undefined) && (
              <div className="truncate font-mono text-[12px] text-muted" title={target.path}>
                {target.path}
                {target.size !== undefined ? `${target.path ? " · " : ""}${formatBytes(target.size)}` : ""}
              </div>
            )}
          </div>
          {canToggle && (
            <button onClick={() => setSource((v) => !v)} className={btn} title={showSource ? "Show it rendered" : "Show the source"}>
              {showSource ? <Eye size={12} /> : <Code2 size={12} />} {showSource ? "Preview" : "Source"}
            </button>
          )}
          {text !== null && (
            <button onClick={() => void copy()} className={btn} title="Copy the contents">
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
            </button>
          )}
          <button onClick={() => window.open(target.viewUrl ?? target.url, "_blank")} className={btn} title="Open in your web browser">
            <ExternalLink size={12} /> Browser
          </button>
          <a href={target.downloadUrl} download={target.name} className={btn} title="Download">
            <Download size={12} /> Download
          </a>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-fg" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <Empty text={error} />
          ) : kind === "image" ? (
            <div className="flex min-h-full items-center justify-center bg-sunken p-4">
              <img src={target.url} alt={target.name} className="max-h-full max-w-full object-contain" />
            </div>
          ) : kind === "pdf" ? (
            <iframe src={target.url} title={target.name} className="h-full w-full border-0 bg-white" />
          ) : kind === "html" && !showSource ? (
            // Its own throwaway origin (no allow-same-origin): the page's scripts run but can't reach Cadre.
            <iframe
              src={target.viewUrl ?? target.url}
              title={target.name}
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals"
              className="h-full w-full border-0 bg-white"
            />
          ) : kind === "other" ? (
            <Empty text="Cadre can't show this kind of file. Download it, or open it in your browser." />
          ) : text === null ? (
            <Empty text="Loading…" />
          ) : kind === "markdown" && !showSource ? (
            <div className="mx-auto max-w-[860px] px-5 py-6 text-[15px] md:px-8">
              <Markdown text={text} />
            </div>
          ) : kind === "csv" && !showSource && rows ? (
            <CsvTable rows={rows} />
          ) : (
            <CodeView text={text} />
          )}
        </div>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full min-h-[200px] items-center justify-center p-6 text-center text-[14px] text-muted">{text}</div>;
}

function CodeView({ text }: { text: string }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const width = String(lines.length).length;
  return (
    <pre className="min-w-max px-0 py-3 font-mono text-[13px] leading-[1.55]">
      {lines.map((l, i) => (
        <div key={i} className="flex hover:bg-sunken/50">
          <span className="sticky left-0 shrink-0 select-none bg-bg pl-4 pr-4 text-right text-muted/70" style={{ width: `${width + 3}ch` }}>
            {i + 1}
          </span>
          <span className="whitespace-pre pr-6">{l || " "}</span>
        </div>
      ))}
    </pre>
  );
}

function CsvTable({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  return (
    <div className="p-3 md:p-4">
      <table className="border-collapse text-[13px]">
        <thead>
          <tr>
            {(head ?? []).map((h, i) => (
              <th key={i} className="sticky top-0 border border-line bg-elev px-2 py-1 text-left font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, MAX_CSV_ROWS).map((r, i) => (
            <tr key={i} className="hover:bg-sunken/50">
              {r.map((c, j) => (
                <td key={j} className="max-w-[420px] truncate border border-line px-2 py-1 align-top" title={c}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > MAX_CSV_ROWS && <div className="mt-2 text-[12.5px] text-muted">Showing the first {MAX_CSV_ROWS} rows. Download it to see the rest.</div>}
    </div>
  );
}
