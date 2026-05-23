"use server"

import { eq } from "drizzle-orm"
import { redirect } from "next/navigation"

import { auth, signOut } from "@/auth"
import { db, schema } from "@/lib/db"

export async function deleteAccountAction() {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/signin")
  }

  const userId = session.user.id

  // Delete the user row.
  // Cascades (via FK ON DELETE CASCADE):
  //   - accounts.user_id → cascade (Auth.js)
  //   - sessions.user_id → cascade (Auth.js, unused in JWT mode)
  //   - claim_tokens.user_id → cascade
  //   - groups.registered_by_user_id → cascade (after the schema change in this increment)
  //     groups cascade → group_members, messages, agent_runs, group_memory, group_rules
  await db.delete(schema.users).where(eq(schema.users.id, userId))

  // Clear the JWT session cookie. redirectTo lands on the landing page.
  await signOut({ redirectTo: "/" })
}
