import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import type { ChannelRow } from "./types.js";

function rowToChannel(row: typeof schema.channels.$inferSelect): ChannelRow {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    models: row.models,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

/** Strips a trailing slash so `${baseUrl}/chat/completions` never double-slashes. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export interface CreateChannelInput {
  name: string;
  baseUrl: string;
  models: string[];
}

export function createChannel(db: MoneySwitchDb, input: CreateChannelInput): ChannelRow {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(schema.channels)
    .values({
      id,
      name: input.name,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      models: input.models,
      enabled: true,
      createdAt: now,
    })
    .run();
  const row = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
  if (!row) throw new Error("failed to read back created channel");
  return rowToChannel(row);
}

export function listChannels(db: MoneySwitchDb): ChannelRow[] {
  return db.select().from(schema.channels).all().map(rowToChannel);
}

export function getChannelById(db: MoneySwitchDb, id: string): ChannelRow | undefined {
  const row = db.select().from(schema.channels).where(eq(schema.channels.id, id)).get();
  return row ? rowToChannel(row) : undefined;
}

export interface UpdateChannelInput {
  name?: string;
  baseUrl?: string;
  models?: string[];
  enabled?: boolean;
}

export function updateChannel(db: MoneySwitchDb, id: string, input: UpdateChannelInput): ChannelRow {
  const patch: Partial<typeof schema.channels.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.baseUrl !== undefined) patch.baseUrl = normalizeBaseUrl(input.baseUrl);
  if (input.models !== undefined) patch.models = input.models;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  db.update(schema.channels).set(patch).where(eq(schema.channels.id, id)).run();
  const row = getChannelById(db, id);
  if (!row) throw new Error("CHANNEL_NOT_FOUND");
  return row;
}

export function deleteChannel(db: MoneySwitchDb, id: string): void {
  db.delete(schema.channels).where(eq(schema.channels.id, id)).run();
}

/**
 * SPEC-v0.2 §2 step 2: finds the enabled channel serving `model`; "multiple
 * hits take the first" — resolved by created_at ascending (oldest channel
 * wins), which is deterministic regardless of insertion/select order.
 */
export function findChannelForModel(db: MoneySwitchDb, model: string): ChannelRow | undefined {
  const rows = db
    .select()
    .from(schema.channels)
    .where(and(eq(schema.channels.enabled, true)))
    .all()
    .map(rowToChannel)
    .filter((c) => c.models.includes(model))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return rows[0];
}

/** All model ids served by currently-enabled channels, deduplicated. */
export function listEnabledModels(db: MoneySwitchDb): string[] {
  const rows = db.select().from(schema.channels).where(eq(schema.channels.enabled, true)).all();
  const set = new Set<string>();
  for (const r of rows) {
    for (const m of r.models as string[]) set.add(m);
  }
  return [...set];
}
