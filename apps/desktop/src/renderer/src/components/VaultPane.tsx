import { useEffect, useRef, useState } from "react";
import { ChevronDown, Contact, CreditCard, KeyRound, Globe, Upload } from "lucide-react";
import type { CreateVaultItemInput, VaultItem, VaultKind } from "@grokbot/shared";
import { api } from "../lib/api";
import { useStore } from "../lib/store";

const KINDS: { kind: VaultKind; label: string; plural: string; icon: React.ReactNode }[] = [
  { kind: "login", label: "Login", plural: "Logins", icon: <Globe size={13} /> },
  { kind: "card", label: "Card", plural: "Cards", icon: <CreditCard size={13} /> },
  { kind: "contact", label: "Contact info", plural: "Contact info", icon: <Contact size={13} /> },
  { kind: "secret", label: "Secret", plural: "Secrets", icon: <KeyRound size={13} /> },
];

const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** Settings → Vault: logins, cards, contact info and secrets the Bots can fill without ever seeing the values. */
export function VaultPane() {
  const vault = useStore((s) => s.vault);
  const loadVault = useStore((s) => s.loadVault);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState<VaultKind | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadVault().catch((err: Error) => setError(err.message));
  }, [loadVault]);

  const importCsv = async (file: File) => {
    setError(null);
    setNote(null);
    if (file.size > MAX_CSV_BYTES) return setError("CSV is larger than 5 MB.");
    try {
      const csv = await file.text();
      const { imported } = await api.vault.importCsv(csv);
      setNote(`Imported ${imported}`);
      await loadVault();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (item: VaultItem) => {
    if (!window.confirm(`Remove "${item.title}" from the Vault? This can't be undone.`)) return;
    setError(null);
    try {
      await api.vault.delete(item.id);
      useStore.setState((s) => ({ vault: s.vault.filter((v) => v.id !== item.id) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <div className="text-[14.5px] font-semibold">Vault</div>
            <div className="text-xs text-muted">Bots fill these in without ever seeing the values. Passwords, card numbers and secrets are never shown here either.</div>
          </div>
          <div className="relative flex shrink-0 items-center gap-1.5">
            <button onClick={() => fileInput.current?.click()} className="flex items-center gap-1 rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken">
              <Upload size={12} /> Import from CSV…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importCsv(f);
              }}
            />
            <button onClick={() => setMenuOpen((v) => !v)} className="flex items-center gap-1 rounded-app bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg">
              New item <ChevronDown size={12} />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full z-40 mt-1 min-w-[160px] rounded-lg border border-line bg-elev p-1 shadow-xl">
                  {KINDS.map((k) => (
                    <button
                      key={k.kind}
                      onClick={() => {
                        setCreating(k.kind);
                        setMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[14.5px] hover:bg-sunken"
                    >
                      {k.icon}
                      {k.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        {note && <div className="text-xs text-accent">{note}</div>}
        {error && <div className="text-xs text-danger">{error}</div>}
      </section>

      {creating && <NewItemForm kind={creating} onClose={() => setCreating(null)} onError={setError} />}

      {vault.length === 0 && !creating ? (
        <div className="rounded-app border border-dashed border-line px-3 py-4 text-center text-xs text-muted">Nothing in the Vault yet. Add a login, card, contact or secret, or import a CSV from your password manager.</div>
      ) : (
        KINDS.map((k) => {
          const items = vault.filter((v) => v.kind === k.kind);
          if (!items.length) return null;
          return (
            <section key={k.kind}>
              <div className="mb-1.5 flex items-center gap-1.5 label-mono">
                {k.icon}
                {k.plural} · {items.length}
              </div>
              <div className="divide-y divide-line rounded-app border border-line bg-elev">
                {items.map((v) => (
                  <ItemRow key={v.id} item={v} onRemove={() => void remove(v)} onError={setError} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function summary(v: VaultItem): { primary: string; secondary: string } {
  switch (v.kind) {
    case "login":
      return { primary: v.website || v.title, secondary: v.username ?? "" };
    case "card":
      return { primary: v.last4 ? `•••• ${v.last4}` : v.title, secondary: [v.nameOnCard, v.expiry].filter(Boolean).join(" · ") };
    case "contact":
      return { primary: v.contact?.name || v.title, secondary: v.contact?.email ?? v.contact?.phone ?? "" };
    case "secret":
      return { primary: v.title, secondary: v.hasSecret ? "••••••••" : "" };
  }
}

function ItemRow({ item, onRemove, onError }: { item: VaultItem; onRemove: () => void; onError: (e: string | null) => void }) {
  const [hints, setHints] = useState(item.hints ?? "");
  useEffect(() => setHints(item.hints ?? ""), [item.id, item.hints]);
  const { primary, secondary } = summary(item);

  const commitHints = async () => {
    if ((hints.trim() || null) === item.hints) return;
    onError(null);
    try {
      const updated = await api.vault.update(item.id, { hints: hints.trim() });
      useStore.setState((s) => ({ vault: s.vault.map((v) => (v.id === updated.id ? updated : v)) }));
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">{primary}</div>
        {secondary && <div className="truncate text-xs text-muted">{secondary}</div>}
      </div>
      <input
        value={hints}
        onChange={(e) => setHints(e.target.value)}
        onBlur={() => void commitHints()}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        placeholder="Hints: when should Bots use this?"
        maxLength={500}
        className="w-56 rounded-app border border-transparent bg-transparent px-2 py-1 text-[13.5px] outline-none placeholder:text-muted/70 hover:border-line focus:border-line focus:bg-sunken"
      />
      <button onClick={onRemove} className="shrink-0 text-xs text-danger hover:underline">
        Remove
      </button>
    </div>
  );
}

function NewItemForm({ kind, onClose, onError }: { kind: VaultKind; onClose: () => void; onError: (e: string | null) => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const v = (k: string) => f[k] ?? "";
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const meta = KINDS.find((k) => k.kind === kind)!;

  const build = (): CreateVaultItemInput | null => {
    const hints = v("hints").trim() || undefined;
    switch (kind) {
      case "login": {
        const website = v("website").trim();
        const username = v("username").trim();
        if (!website && !username) return null;
        return { kind, title: hostOf(website) || username, website: website || undefined, username: username || undefined, password: v("password") || undefined, hints };
      }
      case "card": {
        const number = v("number").replace(/\s+/g, "");
        if (!number) return null;
        return {
          kind,
          title: v("nameOnCard").trim() ? `${v("nameOnCard").trim()} •••• ${number.slice(-4)}` : `Card •••• ${number.slice(-4)}`,
          number,
          expiry: v("expiry").trim() || undefined,
          securityCode: v("securityCode").trim() || undefined,
          nameOnCard: v("nameOnCard").trim() || undefined,
          billingAddress: v("billingAddress").trim() || undefined,
          hints,
        };
      }
      case "contact": {
        const name = v("name").trim();
        if (!name) return null;
        return { kind, title: name, contact: { name, address: v("address").trim() || undefined, phone: v("phone").trim() || undefined, email: v("email").trim() || undefined }, hints };
      }
      case "secret": {
        const title = v("title").trim();
        if (!title || !v("value")) return null;
        return { kind, title, value: v("value"), hints };
      }
    }
  };
  const input = build();

  const submit = async () => {
    if (!input || busy) return;
    setBusy(true);
    onError(null);
    try {
      const item = await api.vault.create(input);
      useStore.setState((s) => ({ vault: s.vault.some((x) => x.id === item.id) ? s.vault : [...s.vault, item] }));
      onClose();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (key: string, placeholder: string, opts: { secret?: boolean; mono?: boolean; wide?: boolean } = {}) => (
    <input
      key={key}
      type={opts.secret ? "password" : "text"}
      value={v(key)}
      onChange={set(key)}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      className={`${inputClass} ${opts.mono ? "font-mono" : ""} ${opts.wide ? "col-span-2" : ""}`}
    />
  );

  return (
    <div className="rounded-app border border-line bg-elev p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[14px] font-medium">
        {meta.icon}
        New {meta.label.toLowerCase()}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {kind === "login" && [field("website", "Website", { wide: true }), field("username", "Username or email"), field("password", "Password", { secret: true })]}
        {kind === "card" && [
          field("number", "Card number", { mono: true, wide: true }),
          field("expiry", "Expiry (MM/YY)", { mono: true }),
          field("securityCode", "Security code", { secret: true, mono: true }),
          field("nameOnCard", "Name on card", { wide: true }),
          field("billingAddress", "Billing address", { wide: true }),
        ]}
        {kind === "contact" && [field("name", "Name", { wide: true }), field("email", "Email"), field("phone", "Phone"), field("address", "Address", { wide: true })]}
        {kind === "secret" && [field("title", "Title (e.g. Linear API key)", { wide: true }), field("value", "Value", { secret: true, mono: true, wide: true })]}
        <input value={v("hints")} onChange={set("hints")} placeholder="Hints: when should Bots use this? (optional)" maxLength={500} className={`${inputClass} col-span-2`} />
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <button onClick={onClose} className="rounded-app px-2.5 py-1 text-xs text-muted hover:bg-sunken">
          Cancel
        </button>
        <button onClick={() => void submit()} disabled={!input || busy} className="rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
          {kind === "login" ? "Save login" : kind === "card" ? "Save card" : kind === "contact" ? "Save contact info" : "Save securely"}
        </button>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  if (!url) return "";
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

const inputClass = "block w-full min-w-0 rounded-app border border-line bg-sunken px-2 py-1 text-[13.5px] outline-none placeholder:text-muted focus:border-accent";
