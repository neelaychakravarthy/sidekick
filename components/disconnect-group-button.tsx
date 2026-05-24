"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { disconnectGroupAction } from "@/lib/group-actions";

export function DisconnectGroupButton({
  groupId,
  groupName,
  platform,
}: {
  groupId: string;
  groupName: string;
  platform: "telegram" | "imessage";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleClick() {
    const platformWord =
      platform === "telegram" ? "Telegram chat" : "iMessage thread";
    const leaveLine =
      platform === "telegram"
        ? "Sidekick will leave the Telegram chat."
        : "Sidekick will stop responding (you'll need to remove Sidekick's number from the iMessage thread manually).";
    const ok = window.confirm(
      `Disconnect Sidekick from "${groupName}"?\n\nAll messages, memory, and rules for this ${platformWord} will be permanently deleted. ${leaveLine}\n\nThis cannot be undone.`,
    );
    if (!ok) return;

    startTransition(async () => {
      try {
        await disconnectGroupAction(groupId);
        router.push("/dashboard");
      } catch (err) {
        console.error("[disconnect] failed", err);
        alert("Disconnect failed. Please try again.");
      }
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      className="inline-flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
    >
      {pending ? "Disconnecting…" : "Disconnect"}
    </button>
  );
}
