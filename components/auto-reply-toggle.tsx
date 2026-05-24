"use client";

import { useState, useTransition } from "react";

import { toggleAutoReply } from "@/lib/group-actions";

export function AutoReplyToggle({
  groupId,
  initialEnabled,
  platform,
}: {
  groupId: string;
  initialEnabled: boolean;
  platform: "telegram" | "imessage";
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  if (platform === "imessage") {
    return (
      <div className="inline-flex items-center gap-2 rounded-full bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
        <span className="size-2 rounded-full bg-green-500" />
        Auto-reply always on
      </div>
    );
  }

  function handleClick() {
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => {
      try {
        await toggleAutoReply(groupId, next);
      } catch {
        setEnabled(!next); // revert on error
      }
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-pressed={enabled}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs transition-colors ${
        enabled
          ? "bg-green-500/15 text-green-700 dark:text-green-400"
          : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
      } disabled:opacity-50`}
    >
      <span
        className={`size-2 rounded-full transition-colors ${
          enabled ? "bg-green-500" : "bg-muted-foreground/50"
        }`}
      />
      Auto-reply {enabled ? "on" : "off"}
    </button>
  );
}
