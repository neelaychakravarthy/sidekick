"use client"

import { useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { deleteAccountAction } from "@/lib/account-actions"

export function DeleteAccountForm() {
  const [text, setText] = useState("")
  const [pending, startTransition] = useTransition()
  const enabled = text === "DELETE" && !pending

  return (
    <form
      action={() => {
        startTransition(async () => {
          await deleteAccountAction()
        })
      }}
      className="space-y-3"
    >
      <label className="block text-sm">
        Type <span className="font-mono font-semibold">DELETE</span> to confirm:
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="mt-1 block h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="DELETE"
          autoComplete="off"
        />
      </label>
      <Button
        type="submit"
        variant="destructive"
        disabled={!enabled}
        className="h-11"
      >
        {pending ? "Deleting…" : "Delete my account and all data"}
      </Button>
    </form>
  )
}
