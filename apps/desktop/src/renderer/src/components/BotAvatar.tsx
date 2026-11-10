import type { AvatarShape } from "@grokbot/shared";

const SHAPE_CLASS: Record<AvatarShape, string> = {
  circle: "rounded-full",
  square: "rounded-md",
  squircle: "rounded-[38%]",
  hexagon: "[clip-path:polygon(50%_0%,95%_25%,95%_75%,50%_100%,5%_75%,5%_25%)]",
};

export function BotAvatar({
  name,
  color,
  shape,
  image,
  size = 32,
  className = "",
}: {
  name: string;
  color: string;
  shape: AvatarShape;
  image?: string | null;
  size?: number;
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div
      className={`flex shrink-0 select-none items-center justify-center font-semibold text-white ${SHAPE_CLASS[shape]} ${className}`}
      style={{ width: size, height: size, background: image ? undefined : color, fontSize: size * 0.38 }}
      aria-label={name}
    >
      {image ? <img src={image} alt={name} className={`h-full w-full object-cover ${SHAPE_CLASS[shape]}`} /> : initials}
    </div>
  );
}
