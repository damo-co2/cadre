import { useEffect, useState } from "react";
import { AlertTriangle, Check, Clock, ShieldAlert, Wrench, X, Zap } from "lucide-react";
import type { ApprovalDecision } from "@grokbot/shared";
import { useStore } from "../lib/store";
import { Collapsible, pretty } from "./Collapsible";

/** Auto Review card rendered in the transcript for an `approval` message part. */
export function ApprovalCard({ approvalId }: { approvalId: string }) {
  const approval = useStore((s) => s.approvals[approvalId] as (typeof s.approvals)[string] | undefined);
  const decide = useStore((s) => s.decideApproval);
  const setAutoMode = useStore((s) => s.setAutoMode);
  // "Always allow" writes a global rule; in a group chat it is hidden so one Bot's action can't silently cover the others.
  const inGroup = useStore((s) => s.conversation?.kind === "group");
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedRule, setSavedRule] = useState(false);

  useEffect(() => {
    if (!savedRule) return;
    const t = setTimeout(() => setSavedRule(false), 2000);
    return () => clearTimeout(t);
  }, [savedRule]);

  if (!approval) {
    return (
      <div className="rounded-app border border-line bg-elev px-3 py-2 text-xs text-muted">
        <ShieldAlert size={12} className="mr-1 inline-block align-[-2px]" /> Approval not found (it may have been cleared).
      </div>
    );
  }

  const act = async (decision: ApprovalDecision) => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      await decide(approval.id, decision);
      if (decision === "always") setSavedRule(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-app border border-signal/40 bg-elev">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-xs font-semibold">
        <ShieldAlert size={13} className="text-signal" />
        Needs approval
        {approval.rule && approval.status !== "pending" && (
          <span className="ml-auto font-normal text-muted" title={approval.rule}>
            by rule
          </span>
        )}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="text-[14.5px]">{approval.summary}</div>
        <Collapsible
          label={
            <span className="flex items-center gap-1.5">
              <Wrench size={12} />
              {approval.toolName}
            </span>
          }
          muted
        >
          {pretty(approval.input)}
        </Collapsible>
        {approval.warnings.map((w, i) => (
          <div key={i} className="flex items-start gap-1.5 rounded-app border border-signal/40 bg-signal/10 px-2.5 py-1.5 text-xs text-signal">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{w}</span>
          </div>
        ))}
        {error && <div className="text-xs text-danger">{error}</div>}
        {approval.status === "pending" ? (
          <div className="flex items-center gap-1.5 pt-1">
            <button
              onClick={() => void act("allow")}
              disabled={busy !== null}
              className="rounded-app bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
            >
              Allow once
            </button>
            {!inGroup && (
              <button
                onClick={() => void act("always")}
                disabled={busy !== null}
                className="rounded-app border border-line px-3 py-1.5 text-xs hover:bg-sunken disabled:opacity-40"
              >
                Always allow
              </button>
            )}
            {approval.warnings.length === 0 && (
              <button
                onClick={() => void setAutoMode(true)}
                disabled={busy !== null}
                className="ml-auto flex items-center gap-1 rounded-app px-2 py-1.5 text-xs text-muted hover:bg-sunken hover:text-fg disabled:opacity-40"
                title="Allow this and stop asking: Bots act on their own. Actions that can't be undone (rm -rf, git push, sudo) still ask."
              >
                <Zap size={12} /> Turn on auto mode
              </button>
            )}
            <button
              onClick={() => void act("deny")}
              disabled={busy !== null}
              className="rounded-app border border-line px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-40"
            >
              Deny
            </button>
          </div>
        ) : (
          <Resolved status={approval.status} savedRule={savedRule} />
        )}
      </div>
    </div>
  );
}

function Resolved({ status, savedRule }: { status: "allowed" | "denied" | "expired"; savedRule: boolean }) {
  return (
    <div className="flex items-center gap-2 pt-1 text-xs">
      {status === "allowed" && (
        <span className="flex items-center gap-1 text-accent">
          <Check size={12} /> Allowed
        </span>
      )}
      {status === "denied" && (
        <span className="flex items-center gap-1 text-danger">
          <X size={12} /> Denied
        </span>
      )}
      {status === "expired" && (
        <span className="flex items-center gap-1 text-muted">
          <Clock size={12} /> Expired — the Bot didn't do the action
        </span>
      )}
      {savedRule && <span className="text-muted">Saved to Custom Rules</span>}
    </div>
  );
}
