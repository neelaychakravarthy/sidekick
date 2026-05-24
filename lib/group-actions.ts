"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { db, schema } from "@/lib/db";

export async function toggleAutoReply(groupId: string, enabled: boolean) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authorized");

  // Verify the user owns this group
  const group = await db.query.groups.findFirst({
    where: eq(schema.groups.id, groupId),
  });
  if (!group || group.registeredByUserId !== session.user.id) {
    throw new Error("Not authorized");
  }

  await db
    .update(schema.groups)
    .set({ autoReplyEnabled: enabled, updatedAt: new Date() })
    .where(eq(schema.groups.id, groupId));

  revalidatePath(`/dashboard/groups/${groupId}`);
}
