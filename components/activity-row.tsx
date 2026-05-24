import Link from "next/link";

const DECISION_TONE: Record<
  string,
  { dot: string; badge: string; label: string }
> = {
  silent: {
    dot: "bg-muted-foreground/40",
    badge: "bg-muted text-muted-foreground",
    label: "silent",
  },
  direct_reply: {
    dot: "bg-blue-500",
    badge: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    label: "direct reply",
  },
  new_action: {
    dot: "bg-green-500",
    badge: "bg-green-500/15 text-green-700 dark:text-green-400",
    label: "action",
  },
  extend_run: {
    dot: "bg-purple-500",
    badge: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
    label: "extended",
  },
};

const PENDING_TONE = {
  dot: "bg-yellow-500 animate-pulse",
  badge: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  label: "pending",
};

export function ActivityRow({
  href,
  intent,
  decision,
  status,
  errorText,
  timestamp,
  groupName,
}: {
  href: string;
  intent: string | null;
  decision: string | null;
  status: string;
  errorText: string | null;
  timestamp: Date;
  groupName?: string;
}) {
  const tone = errorText
    ? {
        dot: "bg-destructive",
        badge: "bg-destructive/15 text-destructive",
        label: "failed",
      }
    : decision
      ? (DECISION_TONE[decision] ?? PENDING_TONE)
      : PENDING_TONE;

  const display =
    intent ??
    (decision === "silent"
      ? "(silent — no response needed)"
      : status === "failed"
        ? "(failed)"
        : "(no summary)");

  return (
    <Link
      href={href}
      className="-mx-3 flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-muted/40"
    >
      <span
        className={`size-2 flex-shrink-0 rounded-full ${tone.dot}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{display}</div>
        <div className="text-xs text-muted-foreground">
          {timestamp.toLocaleString()}
          {groupName ? ` · ${groupName}` : ""}
        </div>
      </div>
      <span
        className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone.badge}`}
      >
        {tone.label}
      </span>
    </Link>
  );
}
