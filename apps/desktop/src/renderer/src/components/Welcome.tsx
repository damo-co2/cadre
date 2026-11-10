import { useMemo } from "react";
import { Menu } from "lucide-react";
import { botsInSpace, useStore } from "../lib/store";

export function Welcome() {
  const setCreateOpen = useStore((s) => s.setCreateOpen);
  const setMobileSidebarOpen = useStore((s) => s.setMobileSidebarOpen);
  const allBots = useStore((s) => s.bots);
  const spaceId = useStore((s) => s.spaceId);
  const bots = useMemo(() => botsInSpace(allBots, spaceId), [allBots, spaceId]);
  const hasChief = bots.some((b) => b.isPrimary);
  return (
    <div className="drag relative flex h-full items-center justify-center overflow-hidden">
      {/* A faint current across the stage. */}
      <div
        className="pointer-events-none absolute -bottom-40 left-1/2 h-[420px] w-[900px] -translate-x-1/2 rounded-[50%] opacity-60 blur-3xl"
        style={{ background: "radial-gradient(closest-side, color-mix(in srgb, var(--accent) 22%, transparent), transparent)" }}
      />
      {bots.length > 0 && (
        <button
          onClick={() => setMobileSidebarOpen(true)}
          className="no-drag absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg md:hidden"
          title="Open sidebar"
        >
          <Menu size={18} />
        </button>
      )}
      <div className="no-drag relative max-w-lg px-6 text-center">
        <div className="tide-mark mx-auto mb-6 h-12 w-12" />
        <h1 className="font-serif text-[44px] leading-[1.05]">{hasChief ? "Build out your team" : "Hire your Chief of Staff"}</h1>
        <p className="mx-auto mt-3 max-w-md text-muted">
          {hasChief
            ? "Add specialists from a template, or describe a role and let your Chief of Staff hire for it."
            : "One Bot that runs the rest: it delegates, tracks every task, hires specialists when the team needs them, and briefs you each morning."}
        </p>
        <div className="mt-7 flex flex-col items-center gap-2">
          <button
            onClick={() => setCreateOpen(true, hasChief ? null : "chief-of-staff")}
            className="rounded-full bg-accent px-6 py-2.5 text-[15px] font-semibold text-accent-fg shadow-tide transition-transform hover:-translate-y-px"
          >
            {hasChief ? "Browse templates" : "Hire a Chief of Staff"}
          </button>
          <button onClick={() => setCreateOpen(true)} className="rounded-full px-4 py-1.5 text-[14px] text-muted hover:bg-elev hover:text-fg">
            {hasChief ? "Or start from a blank Bot" : "Or browse every template"}
          </button>
        </div>
      </div>
    </div>
  );
}
