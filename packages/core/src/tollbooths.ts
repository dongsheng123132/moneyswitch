import { randomUUID, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import {
  checkPayTo,
  normalizeMethod,
  normalizePathPattern,
  normalizeUpstreamUrl,
  slugify,
  SLUG_RE,
  TollPathError,
  UpstreamUrlError,
  type RouteMethod,
  type PayToErrorCode,
} from "@moneyswitch/tollbooth";
import { dbNumberToMicros, microsToDbNumber } from "./money.js";

/** SPEC-v0.5 §2 — toll booths, their price rules, and the income they record. */

export type TollboothErrorCode =
  | "INVALID_NAME"
  | "INVALID_SLUG"
  | "SLUG_TAKEN"
  | "INVALID_UPSTREAM"
  | "UPSTREAM_IS_SELF"
  | "INVALID_PAY_TO"
  | "PAY_TO_REQUIRED"
  | "INVALID_ROUTE"
  | "INVALID_PRICE"
  | "NOT_FOUND";

export class TollboothError extends Error {
  constructor(
    public code: TollboothErrorCode,
    message: string,
    public reason?: PayToErrorCode | string
  ) {
    super(message);
    this.name = "TollboothError";
  }
}

export interface TollboothRow {
  id: string;
  name: string;
  slug: string;
  upstreamUrl: string;
  payTo: string;
  network: string;
  enabled: boolean;
  forwardHostHeader: boolean;
  /** micro-USDC for unmatched requests; null = refuse. */
  defaultPrice: bigint | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TollboothRouteRow {
  id: string;
  tollboothId: string;
  method: RouteMethod;
  pathPattern: string;
  price: bigint;
  description: string | null;
  createdAt: string;
}

export interface TollboothRouteInput {
  method?: string;
  pathPattern: string;
  price: bigint;
  description?: string | null;
}

const MAX_ROUTES = 100;
const MAX_PRICE = 1_000_000_000n; // 1000 USDC per call — a sanity cap, not a business rule

function toRow(r: typeof schema.tollbooths.$inferSelect): TollboothRow {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    upstreamUrl: r.upstreamUrl,
    payTo: r.payTo,
    network: r.network,
    enabled: r.enabled,
    forwardHostHeader: r.forwardHostHeader,
    defaultPrice: r.defaultPrice == null ? null : dbNumberToMicros(r.defaultPrice),
    description: r.description ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toRouteRow(r: typeof schema.tollboothRoutes.$inferSelect): TollboothRouteRow {
  return {
    id: r.id,
    tollboothId: r.tollboothId,
    method: r.method as RouteMethod,
    pathPattern: r.pathPattern,
    price: dbNumberToMicros(r.price),
    description: r.description ?? null,
    createdAt: r.createdAt,
  };
}

export function validatePayToOrThrow(payTo: string): string {
  const check = checkPayTo(payTo);
  if (!check.ok) throw new TollboothError("INVALID_PAY_TO", check.message, check.code);
  return check.address;
}

function validatePrice(p: bigint, field: string): bigint {
  if (p < 0n || p > MAX_PRICE) throw new TollboothError("INVALID_PRICE", `${field} must be between 0 and 1000 USDC`);
  return p;
}

function validateName(name: string | undefined): string {
  const n = String(name ?? "").trim();
  if (!n || n.length > 80) throw new TollboothError("INVALID_NAME", "Name is required (max 80 characters)");
  return n;
}

function validateUpstream(url: string): string {
  try {
    return normalizeUpstreamUrl(url);
  } catch (e) {
    throw new TollboothError("INVALID_UPSTREAM", e instanceof UpstreamUrlError ? e.message : "Invalid upstream URL");
  }
}

function validateRoute(input: TollboothRouteInput): { method: RouteMethod; pathPattern: string; price: bigint; description: string | null } {
  try {
    return {
      method: normalizeMethod(input.method ?? "ANY"),
      pathPattern: normalizePathPattern(input.pathPattern),
      price: validatePrice(input.price, "Route price"),
      description: input.description ? String(input.description).slice(0, 200) : null,
    };
  } catch (e) {
    if (e instanceof TollboothError) throw e;
    throw new TollboothError("INVALID_ROUTE", e instanceof TollPathError ? e.message : "Invalid route");
  }
}

function slugTaken(db: MoneySwitchDb, slug: string, exceptId?: string): boolean {
  const row = db.select({ id: schema.tollbooths.id }).from(schema.tollbooths).where(eq(schema.tollbooths.slug, slug)).get();
  return Boolean(row && row.id !== exceptId);
}

function resolveSlug(db: MoneySwitchDb, name: string, requested: string | undefined, exceptId?: string): string {
  if (requested !== undefined && requested !== null && String(requested).trim() !== "") {
    const s = String(requested).trim().toLowerCase();
    if (!SLUG_RE.test(s)) {
      throw new TollboothError("INVALID_SLUG", "Slug must be 1–48 lower-case letters, digits or dashes (not starting/ending with a dash)");
    }
    if (slugTaken(db, s, exceptId)) throw new TollboothError("SLUG_TAKEN", `The address /t/${s} is already used by another toll booth`);
    return s;
  }
  const base = slugify(name) || `booth-${randomBytes(3).toString("hex")}`;
  let candidate = base;
  for (let i = 2; slugTaken(db, candidate, exceptId); i++) candidate = `${base.slice(0, 44)}-${i}`;
  return candidate;
}

export interface CreateTollboothInput {
  name: string;
  slug?: string;
  upstreamUrl: string;
  payTo: string;
  network: string;
  enabled?: boolean;
  forwardHostHeader?: boolean;
  defaultPrice: bigint | null;
  description?: string | null;
  routes?: TollboothRouteInput[];
}

export function createTollbooth(db: MoneySwitchDb, input: CreateTollboothInput): { tollbooth: TollboothRow; routes: TollboothRouteRow[] } {
  const name = validateName(input.name);
  const upstreamUrl = validateUpstream(input.upstreamUrl);
  const payTo = validatePayToOrThrow(input.payTo);
  const defaultPrice = input.defaultPrice == null ? null : validatePrice(input.defaultPrice, "Default price");
  const routes = (input.routes ?? []).map(validateRoute);
  if (routes.length > MAX_ROUTES) throw new TollboothError("INVALID_ROUTE", `At most ${MAX_ROUTES} rules per toll booth`);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    const slug = resolveSlug(tx as unknown as MoneySwitchDb, name, input.slug);
    tx.insert(schema.tollbooths)
      .values({
        id,
        name,
        slug,
        upstreamUrl,
        payTo,
        network: input.network,
        enabled: input.enabled ?? true,
        forwardHostHeader: input.forwardHostHeader ?? false,
        defaultPrice: defaultPrice == null ? null : microsToDbNumber(defaultPrice),
        description: input.description ? String(input.description).slice(0, 300) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    routes.forEach((r, i) => {
      tx.insert(schema.tollboothRoutes)
        .values({
          id: randomUUID(),
          tollboothId: id,
          method: r.method,
          pathPattern: r.pathPattern,
          price: microsToDbNumber(r.price),
          description: r.description,
          // keep the submitted order stable
          createdAt: new Date(Date.parse(now) + i).toISOString(),
        })
        .run();
    });
  });
  return { tollbooth: getTollbooth(db, id)!, routes: listTollboothRoutes(db, id) };
}

export function getTollbooth(db: MoneySwitchDb, id: string): TollboothRow | undefined {
  const r = db.select().from(schema.tollbooths).where(eq(schema.tollbooths.id, id)).get();
  return r ? toRow(r) : undefined;
}

export function getTollboothBySlug(db: MoneySwitchDb, slug: string): TollboothRow | undefined {
  const r = db.select().from(schema.tollbooths).where(eq(schema.tollbooths.slug, slug)).get();
  return r ? toRow(r) : undefined;
}

export function listTollbooths(db: MoneySwitchDb): TollboothRow[] {
  return db.select().from(schema.tollbooths).orderBy(asc(schema.tollbooths.createdAt)).all().map(toRow);
}

export function listTollboothRoutes(db: MoneySwitchDb, tollboothId: string): TollboothRouteRow[] {
  return db
    .select()
    .from(schema.tollboothRoutes)
    .where(eq(schema.tollboothRoutes.tollboothId, tollboothId))
    .orderBy(asc(schema.tollboothRoutes.createdAt), asc(schema.tollboothRoutes.id))
    .all()
    .map(toRouteRow);
}

export interface UpdateTollboothInput {
  name?: string;
  slug?: string;
  upstreamUrl?: string;
  payTo?: string;
  enabled?: boolean;
  forwardHostHeader?: boolean;
  /** undefined = unchanged; null = refuse unmatched requests. */
  defaultPrice?: bigint | null;
  description?: string | null;
  /** When given, replaces the whole rule list. */
  routes?: TollboothRouteInput[];
}

export function updateTollbooth(db: MoneySwitchDb, id: string, input: UpdateTollboothInput): { tollbooth: TollboothRow; routes: TollboothRouteRow[] } {
  const existing = getTollbooth(db, id);
  if (!existing) throw new TollboothError("NOT_FOUND", "Toll booth not found");
  const patch: Partial<typeof schema.tollbooths.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) patch.name = validateName(input.name);
  if (input.upstreamUrl !== undefined) patch.upstreamUrl = validateUpstream(input.upstreamUrl);
  if (input.payTo !== undefined) patch.payTo = validatePayToOrThrow(input.payTo);
  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
  if (input.forwardHostHeader !== undefined) patch.forwardHostHeader = Boolean(input.forwardHostHeader);
  if (input.defaultPrice !== undefined) {
    patch.defaultPrice = input.defaultPrice == null ? null : microsToDbNumber(validatePrice(input.defaultPrice, "Default price"));
  }
  if (input.description !== undefined) patch.description = input.description ? String(input.description).slice(0, 300) : null;
  const routes = input.routes?.map(validateRoute);
  if (routes && routes.length > MAX_ROUTES) throw new TollboothError("INVALID_ROUTE", `At most ${MAX_ROUTES} rules per toll booth`);
  db.transaction((tx) => {
    if (input.slug !== undefined) patch.slug = resolveSlug(tx as unknown as MoneySwitchDb, patch.name ?? existing.name, input.slug, id);
    tx.update(schema.tollbooths).set(patch).where(eq(schema.tollbooths.id, id)).run();
    if (routes) {
      tx.delete(schema.tollboothRoutes).where(eq(schema.tollboothRoutes.tollboothId, id)).run();
      const now = new Date().toISOString();
      routes.forEach((r, i) => {
        tx.insert(schema.tollboothRoutes)
          .values({
            id: randomUUID(),
            tollboothId: id,
            method: r.method,
            pathPattern: r.pathPattern,
            price: microsToDbNumber(r.price),
            description: r.description,
            // keep the submitted order stable
            createdAt: new Date(Date.parse(now) + i).toISOString(),
          })
          .run();
      });
    }
  });
  return { tollbooth: getTollbooth(db, id)!, routes: listTollboothRoutes(db, id) };
}

export function deleteTollbooth(db: MoneySwitchDb, id: string): void {
  db.transaction((tx) => {
    tx.delete(schema.tollboothRoutes).where(eq(schema.tollboothRoutes.tollboothId, id)).run();
    tx.delete(schema.tollbooths).where(eq(schema.tollbooths.id, id)).run();
  });
}

export function addTollboothRoute(db: MoneySwitchDb, tollboothId: string, input: TollboothRouteInput): TollboothRouteRow {
  if (!getTollbooth(db, tollboothId)) throw new TollboothError("NOT_FOUND", "Toll booth not found");
  if (listTollboothRoutes(db, tollboothId).length >= MAX_ROUTES) throw new TollboothError("INVALID_ROUTE", `At most ${MAX_ROUTES} rules per toll booth`);
  const r = validateRoute(input);
  const id = randomUUID();
  db.insert(schema.tollboothRoutes)
    .values({ id, tollboothId, method: r.method, pathPattern: r.pathPattern, price: microsToDbNumber(r.price), description: r.description, createdAt: new Date().toISOString() })
    .run();
  return toRouteRow(db.select().from(schema.tollboothRoutes).where(eq(schema.tollboothRoutes.id, id)).get()!);
}

export function updateTollboothRoute(
  db: MoneySwitchDb,
  tollboothId: string,
  routeId: string,
  input: Partial<TollboothRouteInput>
): TollboothRouteRow {
  const existing = db
    .select()
    .from(schema.tollboothRoutes)
    .where(and(eq(schema.tollboothRoutes.id, routeId), eq(schema.tollboothRoutes.tollboothId, tollboothId)))
    .get();
  if (!existing) throw new TollboothError("NOT_FOUND", "Rule not found");
  const cur = toRouteRow(existing);
  const r = validateRoute({
    method: input.method ?? cur.method,
    pathPattern: input.pathPattern ?? cur.pathPattern,
    price: input.price ?? cur.price,
    description: input.description !== undefined ? input.description : cur.description,
  });
  db.update(schema.tollboothRoutes)
    .set({ method: r.method, pathPattern: r.pathPattern, price: microsToDbNumber(r.price), description: r.description })
    .where(eq(schema.tollboothRoutes.id, routeId))
    .run();
  return toRouteRow(db.select().from(schema.tollboothRoutes).where(eq(schema.tollboothRoutes.id, routeId)).get()!);
}

export function deleteTollboothRoute(db: MoneySwitchDb, tollboothId: string, routeId: string): boolean {
  const res = db
    .delete(schema.tollboothRoutes)
    .where(and(eq(schema.tollboothRoutes.id, routeId), eq(schema.tollboothRoutes.tollboothId, tollboothId)))
    .run();
  return res.changes > 0;
}

// ---------------------------------------------------------------- earnings

export interface EarningRow {
  id: string;
  tollboothId: string;
  tollboothSlug: string;
  tollboothName: string;
  routeId: string | null;
  method: string;
  path: string;
  amount: bigint;
  payer: string | null;
  txHash: string | null;
  network: string;
  status: "settled" | "failed";
  upstreamStatus: number | null;
  errorCode: string | null;
  createdAt: string;
}

export interface RecordEarningInput {
  tollbooth: Pick<TollboothRow, "id" | "slug" | "name">;
  routeId: string | null;
  method: string;
  path: string;
  amount: bigint;
  payer: string | null;
  txHash: string | null;
  network: string;
  status: "settled" | "failed";
  upstreamStatus: number | null;
  errorCode?: string | null;
}

export function recordEarning(db: MoneySwitchDb, input: RecordEarningInput): EarningRow {
  const id = randomUUID();
  db.insert(schema.earnings)
    .values({
      id,
      tollboothId: input.tollbooth.id,
      tollboothSlug: input.tollbooth.slug,
      tollboothName: input.tollbooth.name,
      routeId: input.routeId,
      method: input.method,
      path: input.path.slice(0, 1024),
      amount: microsToDbNumber(input.amount),
      payer: input.payer,
      txHash: input.txHash,
      network: input.network,
      status: input.status,
      upstreamStatus: input.upstreamStatus,
      errorCode: input.errorCode ?? null,
      createdAt: new Date().toISOString(),
    })
    .run();
  return toEarning(db.select().from(schema.earnings).where(eq(schema.earnings.id, id)).get()!);
}

function toEarning(r: typeof schema.earnings.$inferSelect): EarningRow {
  return {
    id: r.id,
    tollboothId: r.tollboothId,
    tollboothSlug: r.tollboothSlug,
    tollboothName: r.tollboothName,
    routeId: r.routeId ?? null,
    method: r.method,
    path: r.path,
    amount: dbNumberToMicros(r.amount),
    payer: r.payer ?? null,
    txHash: r.txHash ?? null,
    network: r.network,
    status: r.status as "settled" | "failed",
    upstreamStatus: r.upstreamStatus ?? null,
    errorCode: r.errorCode ?? null,
    createdAt: r.createdAt,
  };
}

export interface EarningsQuery {
  tollboothId?: string;
  sinceIso?: string;
  limit?: number;
}

export interface EarningsSummary {
  /** Sum of settled amounts. */
  total: bigint;
  settledCount: number;
  failedCount: number;
  byTollbooth: Array<{ tollboothId: string; slug: string; name: string; total: bigint; count: number }>;
  byRoute: Array<{ tollboothId: string; routeId: string | null; method: string; total: bigint; count: number }>;
  items: EarningRow[];
}

export function queryEarnings(db: MoneySwitchDb, q: EarningsQuery = {}): EarningsSummary {
  const conds = [];
  if (q.tollboothId) conds.push(eq(schema.earnings.tollboothId, q.tollboothId));
  if (q.sinceIso) conds.push(gte(schema.earnings.createdAt, q.sinceIso));
  const where = conds.length ? and(...conds) : undefined;
  const settledWhere = and(eq(schema.earnings.status, "settled"), ...(conds.length ? conds : []));

  const totals = db
    .select({
      total: sql<number>`COALESCE(SUM(CASE WHEN ${schema.earnings.status} = 'settled' THEN ${schema.earnings.amount} ELSE 0 END), 0)`,
      settled: sql<number>`COALESCE(SUM(CASE WHEN ${schema.earnings.status} = 'settled' THEN 1 ELSE 0 END), 0)`,
      failed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.earnings.status} = 'failed' THEN 1 ELSE 0 END), 0)`,
    })
    .from(schema.earnings)
    .where(where)
    .get();

  const byTollbooth = db
    .select({
      tollboothId: schema.earnings.tollboothId,
      slug: sql<string>`MAX(${schema.earnings.tollboothSlug})`,
      name: sql<string>`MAX(${schema.earnings.tollboothName})`,
      total: sql<number>`SUM(${schema.earnings.amount})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.earnings)
    .where(settledWhere)
    .groupBy(schema.earnings.tollboothId)
    .all();

  const byRoute = db
    .select({
      tollboothId: schema.earnings.tollboothId,
      routeId: schema.earnings.routeId,
      method: sql<string>`MAX(${schema.earnings.method})`,
      total: sql<number>`SUM(${schema.earnings.amount})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.earnings)
    .where(settledWhere)
    .groupBy(schema.earnings.tollboothId, schema.earnings.routeId)
    .all();

  const items = db
    .select()
    .from(schema.earnings)
    .where(where)
    .orderBy(desc(schema.earnings.createdAt))
    .limit(Math.min(Math.max(q.limit ?? 500, 1), 5000))
    .all()
    .map(toEarning);

  return {
    total: dbNumberToMicros(totals?.total ?? 0),
    settledCount: Number(totals?.settled ?? 0),
    failedCount: Number(totals?.failed ?? 0),
    byTollbooth: byTollbooth
      .map((r) => ({ tollboothId: r.tollboothId, slug: r.slug, name: r.name, total: dbNumberToMicros(r.total ?? 0), count: Number(r.count) }))
      .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0)),
    byRoute: byRoute.map((r) => ({
      tollboothId: r.tollboothId,
      routeId: r.routeId ?? null,
      method: r.method,
      total: dbNumberToMicros(r.total ?? 0),
      count: Number(r.count),
    })),
    items,
  };
}
