import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
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

export const memorySource = pgEnum("memory_source", ["inferred"]);

export const platform = pgEnum("platform", ["telegram", "imessage"]);

export const outboundStatus = pgEnum("outbound_status", [
  "pending",
  "sending",
  "sent",
  "failed",
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
  // BYO Anthropic API key — encrypted with AES-256-GCM via lib/encryption.ts.
  // Format: base64(iv || ciphertext || authTag) in a single column. Never
  // exposed to the client. When non-null, LLM calls for groups owned by this
  // user use this key and bypass the daily rate limit.
  anthropicApiKeyEncrypted: text("anthropic_api_key_encrypted"),
  anthropicApiKeyAddedAt: timestamp("anthropic_api_key_added_at", {
    withTimezone: true,
  }),
  // Daily free-tier rate-limit counters. Reset is "next UTC midnight" after
  // the previous reset. See lib/usage.ts for the atomic check+increment.
  dailyLlmCallCount: integer("daily_llm_call_count").notNull().default(0),
  dailyLlmCallResetAt: timestamp("daily_llm_call_reset_at", {
    withTimezone: true,
  })
    .defaultNow()
    .notNull(),
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
  platform: platform("platform").notNull().default("telegram"),
  // Telegram-only — nullable now to allow iMessage rows. Telegram rows still
  // populate this; uniqueness is preserved by the unique constraint, which
  // permits multiple NULLs in Postgres.
  telegramChatId: text("telegram_chat_id").unique(),
  // iMessage-only — Photon Spectrum space id.
  photonSpaceId: text("photon_space_id"),
  // iMessage-only — BlueBubbles chat guid (active iMessage backend).
  bluebubblesChatGuid: text("bluebubbles_chat_guid"),
  registeredByUserId: text("registered_by_user_id").references(
    () => users.id,
    { onDelete: "cascade" },
  ),
  name: text("name").notNull(),
  settings: jsonb("settings")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  autoReplyEnabled: boolean("auto_reply_enabled").notNull().default(false),
  // Last time the rate-limit "add your own key" notice was posted in this
  // group. Used to dedup notices to once-per-UTC-day. Null = never posted.
  rateLimitNotifiedAt: timestamp("rate_limit_notified_at", {
    withTimezone: true,
  }),
  // When the one-time "claim me" prompt was posted on an unclaimed group's
  // first @-mention. Set once and never reset — dedups the prompt to a single
  // send per group row. Null = never prompted.
  claimPromptSentAt: timestamp("claim_prompt_sent_at", { withTimezone: true }),
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
    // Telegram-only — nullable so iMessage member rows can coexist.
    telegramUserId: text("telegram_user_id"),
    telegramUsername: text("telegram_username"),
    // iMessage-only — Photon sender id (typically a phone number).
    photonSenderId: text("photon_sender_id"),
    // iMessage-only — BlueBubbles sender handle (email/phone).
    bluebubblesHandle: text("bluebubbles_handle"),
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
    platform: platform("platform").notNull().default("telegram"),
    // Telegram-only — nullable so iMessage rows can coexist.
    telegramMessageId: text("telegram_message_id"),
    telegramUserId: text("telegram_user_id"),
    // iMessage-only.
    photonMessageId: text("photon_message_id"),
    photonSenderId: text("photon_sender_id"),
    // iMessage-only — BlueBubbles message guid (active iMessage backend).
    bluebubblesMessageGuid: text("bluebubbles_message_guid"),
    text: text("text"),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    isBot: boolean("is_bot").notNull().default(false),
  },
  (t) => ({
    groupTgMsgUnique: uniqueIndex("messages_group_tg_msg").on(
      t.groupId,
      t.telegramMessageId,
    ),
  }),
);

export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    platform: platform("platform").notNull().default("imessage"),
    // iMessage target chat GUID (the only platform that uses the outbox today;
    // Telegram sends go direct from Vercel).
    bluebubblesChatGuid: text("bluebubbles_chat_guid"),
    text: text("text").notNull(),
    status: outboundStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    // The external message id (BlueBubbles guid) once the bridge sends it.
    externalMessageId: text("external_message_id"),
    errorText: text("error_text"),
    // Set when the bridge claims the row for sending; used for stale-reclaim.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    statusCreatedIdx: index("outbound_status_created").on(t.status, t.createdAt),
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
  decision: text("decision"),
  extendsRunId: text("extends_run_id").references(
    (): AnyPgColumn => agentRuns.id,
    { onDelete: "set null" },
  ),
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
  outbound: many(outboundMessages),
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

export const outboundMessagesRelations = relations(
  outboundMessages,
  ({ one }) => ({
    group: one(groups, {
      fields: [outboundMessages.groupId],
      references: [groups.id],
    }),
  }),
);

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
