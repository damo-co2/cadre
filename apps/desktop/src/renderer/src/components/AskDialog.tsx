import { useEffect, useRef, useState } from "react";
import { useAsk } from "../lib/ask";
import { Dialog } from "./Dialog";

/** Renders the pending askText() request as a small Tidewater dialog. */
export function AskDialog() {
  const request = useAsk((s) => s.request);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!request) return;
    setValue(request.value);
    // Focus and select after the dialog mounts.
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [request]);

  if (!request) return null;
  const ok = request.allowEmpty || value.trim().length > 0;
  const submit = () => ok && request.resolve(value.trim());

  return (
    <Dialog title={request.title} onClose={() => request.resolve(null)} width={420}>
      <div className="space-y-4">
        {request.label && <div className="label-mono">{request.label}</div>}
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              e.stopPropagation();
              request.resolve(null);
            }
          }}
          placeholder={request.placeholder}
          maxLength={80}
          className="w-full rounded-[10px] border border-line bg-sunken px-3 py-2 text-[15.5px] outline-none focus:border-accent/60"
        />
        <div className="flex justify-end gap-2">
          <button onClick={() => request.resolve(null)} className="rounded-full px-4 py-1.5 text-[14.5px] text-muted hover:bg-sunken hover:text-fg">
            Cancel
          </button>
          <button onClick={submit} disabled={!ok} className="rounded-full bg-accent px-4 py-1.5 text-[14.5px] font-semibold text-accent-fg disabled:opacity-40">
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
