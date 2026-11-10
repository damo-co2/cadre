import { useMemo, useState } from "react";
import { Download, FileText, Image as ImageIcon } from "lucide-react";
import { fileUrl, workspaceUrl } from "../lib/api";
import { formatBytes, isImageFile } from "../lib/files";
import { useStore } from "../lib/store";
import { relativeTime } from "../lib/time";

interface Entry {
  key: string;
  name: string;
  size?: number;
  at: string;
  image: boolean;
  open: string;
  download: string;
}

const PAGE = 12;

/** Every attachment and produced file in the open conversation, newest first, grouped by when. */
export function Library() {
  const messages = useStore((s) => s.messages);
  const [limit, setLimit] = useState(PAGE);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const m of messages) {
      for (const a of m.attachments ?? []) {
        out.push({ key: `a:${a.id}`, name: a.name, size: a.size, at: m.createdAt, image: isImageFile(a.name, a.mimeType), open: fileUrl(a.id), download: fileUrl(a.id, true) });
      }
      for (const p of m.parts) {
        if (p.type !== "file") continue;
        out.push({ key: `f:${m.id}:${p.path}`, name: p.name, size: p.size, at: m.updatedAt || m.createdAt, image: isImageFile(p.name, p.mimeType), open: workspaceUrl(p.path), download: workspaceUrl(p.path, true) });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [messages]);

  if (entries.length === 0) return <div className="text-xs text-muted">Nothing shared yet. Files you attach and files the Bot produces show up here.</div>;

  const shown = entries.slice(0, limit);
  const groups = groupByWhen(shown);

  return (
    <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
      {groups.map(([label, list]) => (
        <div key={label}>
          <div className="mb-0.5 label-mono">{label}</div>
          <div className="space-y-0.5">
            {list.map((e) => (
              <div key={e.key} className="flex items-center gap-2 rounded-app px-1.5 py-1 text-[13.5px] hover:bg-sunken/60">
                {e.image ? <ImageIcon size={13} className="shrink-0 text-muted" /> : <FileText size={13} className="shrink-0 text-muted" />}
                <button onClick={() => window.open(e.open, "_blank")} className="min-w-0 flex-1 truncate text-left hover:text-accent" title={e.name}>
                  {e.name}
                </button>
                <span className="shrink-0 text-[12.5px] text-muted">{relativeTime(e.at)}</span>
                <a href={e.download} download={e.name} className="shrink-0 text-muted hover:text-fg" title={`Download${e.size ? ` · ${formatBytes(e.size)}` : ""}`}>
                  <Download size={12} />
                </a>
              </div>
            ))}
          </div>
        </div>
      ))}
      {entries.length > limit && (
        <button onClick={() => setLimit((n) => n + PAGE)} className="w-full rounded-app border border-line py-1 text-[13px] text-muted hover:bg-sunken hover:text-fg">
          Show more ({entries.length - limit} more)
        </button>
      )}
    </div>
  );
}

function groupByWhen(list: Entry[]): [string, Entry[]][] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekAgo = startOfToday - 6 * 86_400_000;
  const groups: Record<string, Entry[]> = { Today: [], "This week": [], Older: [] };
  for (const e of list) {
    const t = Date.parse(e.at);
    const key = t >= startOfToday ? "Today" : t >= weekAgo ? "This week" : "Older";
    groups[key]!.push(e);
  }
  return (Object.entries(groups) as [string, Entry[]][]).filter(([, l]) => l.length > 0);
}
