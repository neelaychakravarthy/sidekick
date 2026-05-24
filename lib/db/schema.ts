import { relations, sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------- Enums ----------

export const agentRunStatus = pgEnum("agent_run_status", [
  "queued",
  "analyzing",
  "acting",
  "responded",
  "failed",
]);

export const memorySource = pgEnum("memory_source", [
  "inferred",
  "user-stated",
]);

// ---------- Tables ----------

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  googleId: text("google_id").unique(),
  name: text("name"),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

export const groups = pgTable("groups", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  telegramChatId: text("telegram_chat_id").notNull().unique(),
  registeredByUserId: text("registered_by_user_id").references(
    () => users.id,
    { onDelete: "cascade" },
  ),
  name: text("name").notNull(),
  settings: jsonb("settings")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const groupMembers = pgTable(
  "group_members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    telegramUserId: text("telegram_user_id").notNull(),
    telegramUsername: text("telegram_username"),
    displayName: text("display_name"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
  },
  (t) => ({
    groupTgUserUnique: uniqueIndex("group_members_group_tg_user").on(
      t.groupId,
      t.telegramUserId,
    ),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    telegramMessageId: text("telegram_message_id").notNull(),
    telegramUserId: text("telegram_user_id"),
    text: text("text"),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
  },
  (t) => ({
    groupTgMsgUnique: uniqueIndex("messages_group_tg_msg").on(
      t.groupId,
      t.telegramMessageId,
    ),
  }),
);

export const agentRuns = pgTable("agent_runs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  triggerMessageIds: text("trigger_message_ids")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  status: agentRunStatus("status").notNull().default("queued"),
  intentSummary: text("intent_summary"),
  intentKeywords: text("intent_keywords")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  ackMessageId: text("ack_message_id"),
  responseMessageId: text("response_message_id"),
  reasoning: text("reasoning"),
  errorText: text("error_text"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
});

export const agentRunSteps = pgTable("agent_run_steps", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  agentRunId: text("agent_run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const groupMemory = pgTable(
  "group_memory",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    source: memorySource("source").notNull(),
    embedding: text("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    groupKeyUnique: uniqueIndex("group_memory_group_key").on(t.groupId, t.key),
  }),
);

export const groupRules = pgTable("group_rules", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  ruleText: text("rule_text").notNull(),
  createdByTelegramUserId: text("created_by_telegram_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const claimTokens = pgTable("claim_tokens", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ---------- Relations ----------

export const usersRelations = relations(users, ({ many }) => ({
  groups: many(groups),
}));

export const groupsRelations = relations(groups, ({ one, many }) => ({
  registeredBy: one(users, {
    fields: [groups.registeredByUserId],
    references: [users.id],
  }),
  members: many(groupMembers),
  messages: many(messages),
  runs: many(agentRuns),
  memory: many(groupMemory),
  rules: many(groupRules),
}));

export const groupMembersRelations = relations(groupMembers, ({ one }) => ({
  group: one(groups, {
    fields: [groupMembers.groupId],
    references: [groups.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  group: one(groups, {
    fields: [messages.groupId],
    references: [groups.id],
  }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  group: one(groups, {
    fields: [agentRuns.groupId],
    references: [groups.id],
  }),
  steps: many(agentRunSteps),
}));

export const agentRunStepsRelations = relations(agentRunSteps, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentRunSteps.agentRunId],
    references: [agentRuns.id],
  }),
}));

export const groupMemoryRelations = relations(groupMemory, ({ one }) => ({
  group: one(groups, {
    fields: [groupMemory.groupId],
    references: [groups.id],
  }),
}));

export const groupRulesRelations = relations(groupRules, ({ one }) => ({
  group: one(groups, {
    fields: [groupRules.groupId],
    references: [groups.id],
  }),
}));
