import { memo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { copyText } from "../lib/copy";

/** Bot replies as GitHub-flavoured markdown: tables, lists, links (opened outside the app), code. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** A code block with a Copy button in its top-right corner. */
function CodeBlock({ children }: { children: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = (pre.current?.textContent ?? "").replace(/\n$/, "");
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="group/code relative">
      <pre ref={pre} style={{ paddingRight: 44 }}>
        {children}
      </pre>
      <button
        onClick={() => void copy()}
        className={`absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md border border-line bg-elev hover:text-fg ${copied ? "text-accent" : "text-muted opacity-0 focus-visible:opacity-100 group-hover/code:opacity-100 [@media(hover:none)]:opacity-100"}`}
        title={copied ? "Copied" : "Copy"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}
