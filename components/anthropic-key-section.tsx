"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  removeAnthropicKey,
  saveAnthropicKey,
} from "@/lib/account-actions";

type Props = {
  hasKey: boolean;
  addedAt: string | null; // ISO date string, when key was added
  dailyCount: number;
  dailyLimit: number;
  resetCountdown: string; // e.g. "4h 22m" or "37m"
};

export function AnthropicKeySection({
  hasKey,
  addedAt,
  dailyCount,
  dailyLimit,
  resetCountdown,
}: Props) {
  const [rawKey, setRawKey] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const value = rawKey;
    if (!value.trim()) {
      setError("Paste your Anthropic API key first.");
      return;
    }
    startTransition(async () => {
      const result = await saveAnthropicKey(value);
      if (!result.success) {
        setError(result.error);
      } else {
        setRawKey("");
      }
    });
  }

  function handleRemove() {
    startTransition(async () => {
      await removeAnthropicKey();
    });
  }

  const formattedAdded =
    addedAt != null ? new Date(addedAt).toLocaleDateString() : null;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Anthropic API Key</CardTitle>
        {!hasKey ? (
          <CardDescription>
            Use your own key for unlimited usage. Without one, you&apos;re
            capped at {dailyLimit} LLM calls/day on the shared key.
          </CardDescription>
        ) : (
          <CardDescription>
            Your groups bypass the daily free-tier cap while your key is on
            file. Stored encrypted; only used to call Anthropic on your behalf.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasKey ? (
          <>
            <div>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Free tier: {dailyCount}/{dailyLimit} calls today, resets in{" "}
                {resetCountdown}
              </span>
            </div>
            <form onSubmit={handleSave} className="space-y-3">
              <label className="block text-sm">
                Your Anthropic API key
                <input
                  type="password"
                  value={rawKey}
                  onChange={(e) => setRawKey(e.target.value)}
                  className="mt-1 block h-11 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="sk-ant-api03-..."
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : null}
              <Button
                type="submit"
                disabled={pending || rawKey.trim().length === 0}
                className="h-11"
              >
                {pending ? "Saving…" : "Save key"}
              </Button>
            </form>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <div>
                <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-green-700 dark:text-green-400">
                  Using your key{formattedAdded ? ` (added ${formattedAdded})` : ""}
                </span>
              </div>
              <div className="font-mono text-sm text-muted-foreground">
                sk-ant-...****
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={handleRemove}
              className="h-11"
            >
              {pending ? "Removing…" : "Remove key"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
