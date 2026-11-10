import type { Bot } from "@grokbot/shared";
import { BotAvatar } from "./BotAvatar";

/** Up to `max` overlapping member avatars, for group rows and headers. */
export function AvatarStack({ bots, size = 22, max = 3, className = "" }: { bots: Bot[]; size?: number; max?: number; className?: string }) {
  const shown = bots.slice(0, max);
  const extra = bots.length - shown.length;
  const step = Math.round(size * 0.62);
  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: step * (shown.length - 1) + size + (extra > 0 ? step : 0), height: size }}>
      {shown.map((b, i) => (
        <div key={b.id} className="absolute top-0 rounded-full ring-2 ring-bg" style={{ left: i * step, zIndex: i }}>
          <BotAvatar name={b.name} color={b.avatarColor} shape={b.avatarShape} image={b.avatarImage} size={size} />
        </div>
      ))}
      {extra > 0 && (
        <div
          className="absolute top-0 flex items-center justify-center rounded-full bg-sunken font-medium text-muted ring-2 ring-bg"
          style={{ left: shown.length * step, width: size, height: size, fontSize: size * 0.4, zIndex: shown.length }}
        >
          +{extra}
        </div>
      )}
    </div>
  );
}

export function groupTitle(title: string | null | undefined, members: Bot[]): string {
  if (title?.trim()) return title.trim();
  if (members.length === 0) return "Group chat";
  return members.map((b) => b.name).join(", ");
}
