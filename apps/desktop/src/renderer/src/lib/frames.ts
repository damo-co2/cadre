/**
 * Tiny pub/sub for screen frames. Frames arrive many times a second, so they bypass zustand
 * (which would re-render every subscriber) and go straight to whoever is drawing the canvas.
 */
export interface ScreenFrame {
  /** JPEG, base64 (no data-URL prefix). */
  data: string;
  width: number;
  height: number;
}

type FrameListener = (frame: ScreenFrame) => void;

const listeners = new Map<string, Set<FrameListener>>();

export const frameBus = {
  subscribe(botId: string, cb: FrameListener): () => void {
    let set = listeners.get(botId);
    if (!set) {
      set = new Set();
      listeners.set(botId, set);
    }
    set.add(cb);
    return () => {
      const s = listeners.get(botId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) listeners.delete(botId);
    };
  },
  publish(botId: string, frame: ScreenFrame): void {
    const set = listeners.get(botId);
    if (!set) return;
    for (const cb of set) cb(frame);
  },
  hasSubscribers(botId: string): boolean {
    return (listeners.get(botId)?.size ?? 0) > 0;
  },
};
