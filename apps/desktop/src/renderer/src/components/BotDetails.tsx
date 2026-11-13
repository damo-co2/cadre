import { useEffect, useState } from "react";
import type { Bot } from "@grokbot/shared";
import { AVATAR_COLORS, AVATAR_SHAPES } from "@grokbot/shared";
import { useStore } from "../lib/store";
import { BotAvatar } from "./BotAvatar";
import { ModelPicker } from "./ModelPicker";
import { defaultLabel, prettyModel, useDefaultModel } from "../lib/defaultModel";
import { RoutinesList } from "./RoutinesList";
import { Library } from "./Library";
import { CompactButton } from "./CompactButton";

export function BotDetails({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const updateBot = useStore((s) => s.updateBot);
  const deleteBot = useStore((s) => s.deleteBot);
  const resetConversation = useStore((s) => s.resetConversation);
  const conversationId = useStore((s) => s.conversation?.id);
  const spaces = useStore((s) => s.spaces);
  const moveBotToSpace = useStore((s) => s.moveBotToSpace);
  // A Bot without its own model uses its space's default, then the app default.
  const effectiveDefault = useDefaultModel(bot.spaceId);
  const appDefault = useStore((s) => s.settings.defaultModelRef);
  const updateSettings = useStore((s) => s.updateSettings);
  const [name, setName] = useState(bot.name);
  const [label, setLabel] = useState(bot.label ?? "");
  const [brief, setBrief] = useState(bot.brief ?? "");

  useEffect(() => {
    setName(bot.name);
    setLabel(bot.label ?? "");
    setBrief(bot.brief ?? "");
  }, [bot.id, bot.name, bot.label, bot.brief]);

  const commit = () => {
    const patch: Parameters<typeof updateBot>[1] = {};
    if (name.trim() && name.trim() !== bot.name) patch.name = name.trim();
    if ((label.trim() || null) !== bot.label) patch.label = label.trim() || null;
    if ((brief.trim() || null) !== (bot.brief ?? null)) patch.brief = brief.trim() || null;
    if (Object.keys(patch).length) void updateBot(bot.id, patch);
  };

  return (
    <>
      <div className="no-drag fixed inset-0 z-30" onClick={onClose} />
      <div className="no-drag absolute left-3 top-[58px] z-40 max-h-[calc(100dvh-80px)] w-[min(360px,calc(100vw-24px))] overflow-y-auto rounded-[14px] border border-line bg-elev p-4 shadow-tide md:top-[66px]">
        <div className="mb-4 flex items-center gap-3">
          <BotAvatar name={bot.name} color={bot.avatarColor} shape={bot.avatarShape} image={bot.avatarImage} size={44} />
          <div className="min-w-0 flex-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              className="w-full bg-transparent font-serif text-[22px] leading-tight outline-none"
            />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              placeholder="Add a role, e.g. Chief of Staff"
              className="w-full bg-transparent text-[13.5px] text-muted outline-none placeholder:text-muted/70"
            />
          </div>
        </div>

        <Field label="Role brief">
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onBlur={commit}
            rows={5}
            maxLength={6000}
            placeholder={
              bot.isPrimary
                ? "This Bot is the Chief of Staff. Describe how it should run the team: priorities, when to hire, what to never do without asking."
                : "The standing job description: responsibilities, standards, what to never do. Part of every turn."
            }
            className="w-full resize-y rounded-[10px] border border-line bg-sunken px-2.5 py-2 text-[14px] leading-relaxed outline-none placeholder:text-muted/70 focus:border-accent/60"
          />
          <div className="mt-1 font-mono text-[12px] text-muted">Saved when you click away · {brief.length}/6000</div>
        </Field>

        <Field label="Picture">
          <div className="flex items-center gap-2">
            {AVATAR_SHAPES.map((s) => (
              <button
                key={s}
                onClick={() => void updateBot(bot.id, { avatarShape: s })}
                className={`rounded-md border p-1 ${bot.avatarShape === s ? "border-accent" : "border-line"}`}
              >
                <BotAvatar name=" " color={bot.avatarColor} shape={s} size={18} />
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => void updateBot(bot.id, { avatarColor: c })}
                className={`h-5 w-5 rounded-full border-2 ${bot.avatarColor === c ? "border-fg" : "border-transparent"}`}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>

        <Field label="Model">
          <ModelPicker value={bot.modelRef} allowDefault defaultLabel={defaultLabel(effectiveDefault)} onChange={(ref) => void updateBot(bot.id, { modelRef: ref })} />
          {bot.isPrimary && (
            <p className="mt-1.5 text-xs text-muted">
              Changing this also switches every Bot in {spaces.find((s) => s.id === bot.spaceId)?.name ?? "this space"}, and Bots hired later.
            </p>
          )}
          {bot.modelRef && bot.modelRef !== appDefault && (
            <button onClick={() => void updateSettings({ defaultModelRef: bot.modelRef })} className="mt-1.5 text-xs text-accent hover:underline">
              Use {prettyModel(bot.modelRef)} as the default for all Bots
            </button>
          )}
        </Field>

        {spaces.length > 1 && (
          <Field label="Space">
            <select
              value={bot.spaceId}
              onChange={(e) => void moveBotToSpace(bot.id, e.target.value)}
              className="w-full rounded-app border border-line bg-sunken px-2 py-1.5 text-[13.5px] outline-none"
            >
              {spaces.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.emoji} {x.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Routines">
          <RoutinesList botId={bot.id} />
        </Field>

        <Field label="Library">
          <Library />
        </Field>

        <div className="mt-3 grid grid-cols-2 gap-1.5 text-[14px]">
          <Btn onClick={() => void updateBot(bot.id, { pinned: !bot.pinned })}>{bot.pinned ? "Unpin" : "Pin"}</Btn>
          <Btn onClick={() => void updateBot(bot.id, { hidden: !bot.hidden })}>{bot.hidden ? "Show in sidebar" : "Hide from sidebar"}</Btn>
          <Btn disabled={bot.isPrimary} onClick={() => void updateBot(bot.id, { isPrimary: true })}>
            {bot.isPrimary ? "Primary Bot" : "Make primary"}
          </Btn>
          <Btn
            onClick={() => {
              if (window.confirm("Reset this conversation? Messages are cleared; the Bot's memory is kept.")) void resetConversation();
            }}
          >
            Reset conversation
          </Btn>
          {conversationId && <CompactButton conversationId={conversationId} className="col-span-2" />}
          <Btn
            danger
            onClick={() => {
              if (window.confirm(`Delete ${bot.name}? This erases its profile, conversation and memory. This can't be undone.`)) {
                onClose();
                void deleteBot(bot.id);
              }
            }}
          >
            Delete Bot
          </Btn>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 label-mono">{label}</div>
      {children}
    </div>
  );
}

function Btn({ children, onClick, danger, disabled }: { children: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-app border px-2.5 py-1.5 text-left disabled:opacity-50 ${
        danger ? "border-danger/30 text-danger hover:bg-danger/10" : "border-line hover:bg-sunken"
      }`}
    >
      {children}
    </button>
  );
}
