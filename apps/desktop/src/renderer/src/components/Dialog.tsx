import { X } from "lucide-react";

/**
 * Modal shell. Desktop: a centred card of the given width. Phone (<768px): fills the screen so the
 * content has room and the keyboard does not fight a floating card.
 */
export function Dialog({
  title,
  onClose,
  children,
  width = 520,
  tall,
  padding = true,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  /** Let the body grow to ~80vh (galleries) instead of the default 70vh. */
  tall?: boolean;
  /** Set false when the child lays out its own edges (Settings). */
  padding?: boolean;
}) {
  return (
    <div className="no-drag fixed inset-0 z-40 flex items-center justify-center bg-[#041012]/50 p-0 backdrop-blur-[2px] md:p-6" onMouseDown={onClose}>
      <div
        className="flex h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-line bg-elev shadow-2xl md:h-auto md:max-h-full md:max-w-(--dialog-w) md:rounded-[14px] md:border"
        style={{ "--dialog-w": `${width}px` } as React.CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
          <div className="font-serif text-[22px] leading-none">{title}</div>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-sunken hover:text-fg">
            <X size={16} />
          </button>
        </div>
        <div className={`min-h-0 flex-1 overflow-y-auto ${padding ? "p-5" : ""} ${tall ? "md:max-h-[80vh]" : "md:max-h-[70vh]"}`}>{children}</div>
      </div>
    </div>
  );
}
