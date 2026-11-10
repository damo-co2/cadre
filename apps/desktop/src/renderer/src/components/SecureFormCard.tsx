import { useState } from "react";
import { Check, Clock, LockKeyhole, X } from "lucide-react";
import type { SecureFormRequest } from "@grokbot/shared";
import { useStore } from "../lib/store";

/**
 * Secure Form: the Bot asks for a secret; the user types it here and it goes straight to the Vault.
 * The values never appear in the transcript, and the Bot never sees them.
 */
export function SecureFormCard({ requestId }: { requestId: string }) {
  const request = useStore((s) => s.secureForms[requestId] as SecureFormRequest | undefined);
  const fill = useStore((s) => s.fillSecureForm);
  const cancel = useStore((s) => s.cancelSecureForm);
  const [values, setValues] = useState<Record<string, string>>({});
  const [title, setTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!request) {
    return (
      <div className="rounded-app border border-line bg-elev px-3 py-2 text-xs text-muted">
        <LockKeyhole size={12} className="mr-1 inline-block align-[-2px]" /> Secure Form not found (it may have been cleared).
      </div>
    );
  }

  const complete = request.fields.every((f) => (values[f.key] ?? "").length > 0);
  const effectiveTitle = title ?? request.label;

  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      await fill(request.id, values, effectiveTitle.trim() || undefined);
      setValues({});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const notNow = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancel(request.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-app border border-accent/40 bg-elev">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-xs font-semibold">
        <LockKeyhole size={13} className="text-accent" />
        Secure Form
        <span className="ml-auto font-normal text-muted">Saved to Vault · never shown to the Bot</span>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="text-[14.5px]">{request.label}</div>
        {request.status === "pending" ? (
          <>
            <div className="space-y-1.5">
              {request.fields.map((f) => (
                <input
                  key={f.key}
                  type={f.secret ? "password" : "text"}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                  placeholder={f.label}
                  autoComplete="off"
                  spellCheck={false}
                  className="block w-full rounded-app border border-line bg-sunken px-2.5 py-1.5 text-[14px] outline-none placeholder:text-muted focus:border-accent"
                />
              ))}
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[12.5px] text-muted">Save as</span>
                <input
                  value={effectiveTitle}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={120}
                  className="min-w-0 flex-1 rounded-app border border-line bg-sunken px-2.5 py-1 text-[13.5px] outline-none focus:border-accent"
                />
                <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 text-[12px] text-muted">{request.saveAs}</span>
              </div>
            </div>
            {error && <div className="text-xs text-danger">{error}</div>}
            <div className="flex items-center gap-1.5 pt-1">
              <button
                onClick={() => void submit()}
                disabled={!complete || busy}
                className="rounded-app bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
              >
                Submit securely
              </button>
              <button onClick={() => void notNow()} disabled={busy} className="rounded-app border border-line px-3 py-1.5 text-xs hover:bg-sunken disabled:opacity-40">
                Not now
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-1 pt-1 text-xs">
            {request.status === "filled" && (
              <span className="flex items-center gap-1 text-accent">
                <Check size={12} /> Saved to Vault · the Bot can use it now
              </span>
            )}
            {request.status === "cancelled" && (
              <span className="flex items-center gap-1 text-muted">
                <X size={12} /> Not now — the Bot continued without it
              </span>
            )}
            {request.status === "expired" && (
              <span className="flex items-center gap-1 text-muted">
                <Clock size={12} /> Expired — the Bot didn't get it
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
