import { useCallback, useRef, useState, type ReactNode } from "react";

/** How far past the minimum you drag before the panel folds away on release. */
const FOLD_PAST = 70;

function readWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(`cadre.width.${key}`));
    return v >= min && v <= max ? v : fallback;
  } catch {
    return fallback;
  }
}

function saveWidth(key: string, w: number): void {
  try {
    localStorage.setItem(`cadre.width.${key}`, String(Math.round(w)));
  } catch {
    /* private window: the width just isn't remembered */
  }
}

/**
 * A side panel you can resize by dragging its inner edge. Drag it well below its minimum and let go to
 * fold it away (onCollapse); double-click the edge to go back to the default width. The width is remembered.
 */
export function ResizablePanel({
  side,
  storageKey,
  defaultWidth,
  min,
  max,
  onCollapse,
  children,
}: {
  /** Which side of the window the panel sits on (the handle is on its inner edge). */
  side: "left" | "right";
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  onCollapse?: () => void;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(() => readWidth(storageKey, defaultWidth, min, max));
  const [dragging, setDragging] = useState(false);
  const [folding, setFolding] = useState(false);
  const start = useRef({ x: 0, w: 0 });

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { x: e.clientX, w: width };
      setDragging(true);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const dx = e.clientX - start.current.x;
      const raw = start.current.w + (side === "left" ? dx : -dx);
      setFolding(!!onCollapse && raw < min - FOLD_PAST);
      setWidth(Math.min(max, Math.max(min, raw)));
    },
    [dragging, side, min, max, onCollapse],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setDragging(false);
      if (folding) {
        setFolding(false);
        setWidth(start.current.w); // comes back at its old width next time
        onCollapse?.();
        return;
      }
      saveWidth(storageKey, width);
    },
    [dragging, folding, onCollapse, storageKey, width],
  );

  const reset = () => {
    setWidth(defaultWidth);
    saveWidth(storageKey, defaultWidth);
  };

  return (
    // Shrinks down to `min` when the window is too narrow, so the chat between the panels keeps its room.
    <div className={`relative flex h-full shrink ${folding ? "opacity-40" : ""}`} style={{ flexBasis: width, maxWidth: width, minWidth: min }}>
      <div className="flex h-full min-w-0 flex-1">{children}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(width)}
        aria-valuemin={min}
        aria-valuemax={max}
        title={onCollapse ? "Drag to resize · drag far in to hide · double-click to reset" : "Drag to resize · double-click to reset"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
        className={`no-drag group absolute inset-y-0 z-20 w-[9px] cursor-col-resize ${side === "left" ? "-right-[5px]" : "-left-[5px]"}`}
      >
        <div className={`mx-auto h-full w-[2px] transition-colors ${dragging ? "bg-accent" : "bg-transparent group-hover:bg-accent/50"}`} />
      </div>
      {/* While dragging, keep the cursor and stop iframes/text from grabbing the pointer. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  );
}
