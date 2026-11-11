import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DomainExpiry, Monitor, MonitorStatus, RegionResult, Scope, TimeCoverage } from "@openuptime/repo";
import type { DbExecutor as Db } from "./client";
import * as schema from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const RPC_RETRY_MS = 300_000;
let rpcUnavailableUntil = 0;

export function resetBatchRpcCache() {
  rpcUnavailableUntil = 0;
}

function isUndefinedFunction(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null | undefined;
  return e?.code === "42883" || e?.cause?.code === "42883";
}

function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/** Bound application clock skew by the database clock; repair impossible future events on the next write. */
export async function coverageTime(tx: Tx, monitorId: string, completedAt = new Date()): Promise<Date> {
  // One round trip. The clock is cut to milliseconds, the precision of the times written after it. Rows after the clock
  // move back to it, so the latest observation afterwards is the earlier of the latest one before and the clock; the
  // final select reads the statement's snapshot, from before the update.
  const [row] = await tx.execute<{ at: Date | string; last: Date | string | null }>(sql`
    with clock as materialized (select date_trunc('milliseconds', clock_timestamp()) as at),
    moved as (
      update monitor_observation o
      set observed_at = clock.at,
        valid_until = case when o.valid_until is null then null else o.valid_until - (o.observed_at - clock.at) end
      from clock
      where o.monitor_id = ${monitorId} and o.observed_at > clock.at
    )
    select clock.at, case when latest.at is null then null else least(latest.at, clock.at) end as last
    from clock, (select max(observed_at) as at from monitor_observation where monitor_id = ${monitorId}) latest`);
  const dbAt = new Date(row.at);
  const last = row.last == null ? 0 : new Date(row.last).getTime();
  return new Date(Math.max(Math.min(completedAt.getTime(), dbAt.getTime()), last));
}

export async function recordObservation(db: Db, snapshot: Monitor, result: { ok: boolean; latencyMs?: number | null; degraded?: boolean }, options: { generation?: number; heartbeatPing?: boolean } = {}): Promise<boolean> {
  return !!(await appendObservation(db, snapshot, result, options));
}

/** A ping is evidence for the current configuration and renews its deadline in the same transaction. */
export function recordHeartbeatObservation(db: Db, snapshot: Monitor): Promise<Monitor | null> {
  return appendObservation(db, snapshot, { ok: true }, { heartbeatPing: true });
}

/** Store the configuration that actually produced the observation. Never re-interpret old data with today's config. */
async function appendObservation(db: Db, snapshot: Monitor, result: { ok: boolean; latencyMs?: number | null; degraded?: boolean }, options: { generation?: number; heartbeatPing?: boolean } = {}): Promise<Monitor | null> {
  // Capture completion before waiting on the lock: database congestion must not extend freshness.
  const completedAt = new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(schema.monitor).where(eq(schema.monitor.id, snapshot.id)).for("update");
    if (!current || current.paused || (!options.heartbeatPing && current.coverageRevision !== (snapshot.coverageRevision ?? 0))) return null;
    if (options.heartbeatPing && current.type !== "heartbeat") return null;
    const generation = options.generation;
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation <= 0 || generation > current.runGeneration || generation <= current.coverageGeneration)) return null;
    const at = await coverageTime(tx, current.id, completedAt);
    // Only a failed scheduled heartbeat check compares itself with the last observation.
    const [last] = current.type === "heartbeat" && !options.heartbeatPing && !result.ok
      ? await tx.select().from(schema.monitorObservation).where(eq(schema.monitorObservation.monitorId, snapshot.id))
        .orderBy(desc(schema.monitorObservation.observedAt), desc(schema.monitorObservation.id)).limit(1)
      : [];
    // The ping fence is committed with the observation, not the later mutable lastCheckedAt/incident updates.
    if (current.type === "heartbeat" && !options.heartbeatPing && current.coverageHeartbeatVersion !== (snapshot.coverageHeartbeatVersion ?? 0)) return null;
    // A scheduler may load the new ping version before the ping handler updates nextCheckAt.
    // Check the committed observation under the same lock, not that mutable deadline.
    if (current.type === "heartbeat" && !options.heartbeatPing && !result.ok
      && last?.revision === current.coverageRevision && (last.state === "up" || last.state === "degraded")
      && last.validUntil && last.validUntil > at) return null;
    const durationMs = current.type === "heartbeat"
      ? (current.intervalSec + current.graceSec) * 1000
      : current.intervalSec * 1000 + current.timeoutMs + 60_000;
    const windows = await tx.select({ endsAt: schema.maintenanceWindow.endsAt }).from(schema.maintenanceWindow).where(and(
      eq(schema.maintenanceWindow.organizationId, current.organizationId),
      current.projectId ? or(isNull(schema.maintenanceWindow.projectId), eq(schema.maintenanceWindow.projectId, current.projectId)) : isNull(schema.maintenanceWindow.projectId),
      lte(schema.maintenanceWindow.startsAt, at), gt(schema.maintenanceWindow.endsAt, at),
      or(sql`cardinality(${schema.maintenanceWindow.monitorIds}) = 0`, sql`${current.id} = any(${schema.maintenanceWindow.monitorIds})`),
    ));
    const maintenanceUntil = windows.length ? new Date(Math.max(...windows.map((w) => w.endsAt.getTime()))) : null;
    await tx.insert(schema.monitorObservation).values({
      monitorId: current.id, observedAt: at,
      state: !result.ok ? "down" : result.degraded || (result.latencyMs != null && result.latencyMs > current.slowThresholdMs) ? "degraded" : "up",
      validUntil: new Date(at.getTime() + durationMs), maintenanceUntil,
      revision: current.coverageRevision, generation, intervalSec: current.intervalSec, graceSec: current.graceSec, timeoutMs: current.timeoutMs,
    });
    if (options.heartbeatPing) {
      const [updated] = await tx.update(schema.monitor).set({
        coverageHeartbeatVersion: current.coverageHeartbeatVersion + 1,
        consecutiveSuccesses: sql`least(${schema.monitor.consecutiveSuccesses} + 1, ${schema.monitor.recoveryThreshold})`,
        consecutiveFailures: 0, lastCheckedAt: at,
        nextCheckAt: sql`clock_timestamp() + make_interval(secs => ${schema.monitor.intervalSec} + ${schema.monitor.graceSec})`,
        status: current.status === "down" ? "down" : "up",
        ...(current.status !== "down" && current.status !== "up" ? { statusChangedAt: at } : {}),
      }).where(eq(schema.monitor.id, current.id)).returning();
      return updated;
    }
    if (generation !== undefined) await tx.update(schema.monitor).set({
      ...(generation !== undefined ? { coverageGeneration: generation } : {}),
    }).where(eq(schema.monitor.id, current.id));
    return current;
  });
}

type CheckInput = {
  ok: boolean;
  statusCode?: number | null;
  latencyMs?: number | null;
  error?: string | null;
  degraded?: boolean;
  domainExpiry?: DomainExpiry | null;
};

type CheckOutcomeRow = {
  accepted: boolean;
  suppressedMaintenance?: boolean;
  inMaintenance?: boolean;
  parentDown?: boolean;
  wantsSlowIncident?: boolean;
  goingDown?: boolean;
  recovering?: boolean;
  opensOutage?: boolean;
  slowTrips?: boolean;
  slowClears?: boolean;
  checkLateOpen?: boolean;
  pending?: boolean;
  nextStatus?: MonitorStatus;
  finalSlow?: number;
};

/** Compute post-check monitor state transitions from the locked monitor row and check measurements. */
function evaluateTransition(current: typeof schema.monitor.$inferSelect, result: CheckInput, inMaintenance: boolean, parentDown: boolean) {
  const successes = result.ok && current.status === "down"
    ? Math.min(current.consecutiveSuccesses + 1, current.recoveryThreshold)
    : !result.ok && current.consecutiveSuccesses !== 0 ? 0 : current.consecutiveSuccesses;
  const recoveryReady = successes >= current.recoveryThreshold;
  const failures = result.ok ? 0 : current.consecutiveFailures + 1;
  const slow = current.type !== "domain" && result.ok && !!result.latencyMs && result.latencyMs > current.slowThresholdMs;
  const slowCount = !result.ok ? current.consecutiveSlow : slow ? current.consecutiveSlow + 1 : 0;
  const nextStatus: MonitorStatus = result.ok
    ? (current.status === "down" && !recoveryReady ? "down" : (slow || result.degraded) ? "degraded" : "up")
    : failures >= current.failureThreshold ? "down" : current.type === "domain" ? "degraded" : current.status;
  const goingDown = nextStatus === "down" && current.status !== "down";
  const recovering = result.ok && current.status === "down" && recoveryReady;
  const wantsSlowIncident = nextStatus !== "down" && !result.degraded && slow && current.slowAlertAfter > 0 && slowCount === current.slowAlertAfter;
  const slowTrips = wantsSlowIncident && !inMaintenance && !parentDown;
  const slowClears = result.ok && !slow && current.consecutiveSlow > 0;
  const finalSlow = nextStatus === "down" ? 0 : slowCount;
  const opensOutage = goingDown && !parentDown;
  const checkLateOpen = !result.ok && !goingDown && nextStatus === "down" && current.status === "down" && !!current.dependsOnMonitorId && !parentDown;
  const pending = opensOutage || recovering || slowTrips || slowClears;
  return { successes, failures, nextStatus, finalSlow, goingDown, recovering, wantsSlowIncident, slowTrips, slowClears, opensOutage, checkLateOpen, pending };
}

async function recordCheckOutcomeFallback(
  db: Db,
  snapshot: Monitor,
  result: CheckInput,
  results: RegionResult[],
  options: { generation?: number },
  completedAt: Date,
): Promise<CheckOutcomeRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({
      monitor: schema.monitor,
      parentDown: sql<boolean>`coalesce((select p.type <> 'domain' and p.status = 'down' from monitor p where p.id = ${schema.monitor.dependsOnMonitorId}), false)`,
    }).from(schema.monitor).where(eq(schema.monitor.id, snapshot.id)).for("update");
    const current = row?.monitor;
    if (!current || current.paused || current.coverageRevision !== (snapshot.coverageRevision ?? 0)) return { accepted: false };
    const generation = options.generation;
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation <= 0 || generation > current.runGeneration || generation <= current.coverageGeneration)) return { accepted: false };
    if (current.type === "heartbeat" && current.coverageHeartbeatVersion !== (snapshot.coverageHeartbeatVersion ?? 0)) return { accepted: false };
    if (result.domainExpiry && (current.type !== "domain" || current.target !== snapshot.target || current.domainExpiryWarnDays !== (snapshot.domainExpiryWarnDays ?? 30))) {
      return { accepted: false };
    }

    const needLastHb = current.type === "heartbeat" && !result.ok;
    const now = new Date();
    const [ctx] = (await tx.execute<{
      at: Date | string; last: Date | string | null; maint_until: Date | string | null; in_maint: boolean;
      hb_rev: number | null; hb_state: string | null; hb_valid: Date | string | null;
    }>(sql`
      with clock as materialized (select date_trunc('milliseconds', clock_timestamp()) as at),
      moved as (
        update monitor_observation o set observed_at = clock.at,
          valid_until = case when o.valid_until is null then null else o.valid_until - (o.observed_at - clock.at) end
        from clock where o.monitor_id = ${current.id} and o.observed_at > clock.at
      ),
      latest as (select max(observed_at) as at from monitor_observation where monitor_id = ${current.id}),
      obs_at as (
        select case when latest.at is null then least(${completedAt.toISOString()}::timestamptz, clock.at)
          else greatest(least(${completedAt.toISOString()}::timestamptz, clock.at), least(latest.at, clock.at)) end as at
        from clock, latest
      ),
      maint as (
        select max(ends_at) filter (where starts_at <= obs_at.at and ends_at > obs_at.at) as maint_until,
          coalesce(bool_or(starts_at <= ${now.toISOString()}::timestamptz and ends_at >= ${now.toISOString()}::timestamptz), false) as in_maint
        from maintenance_window, obs_at
        where organization_id = ${current.organizationId}
          and (${current.projectId ? sql`project_id is null or project_id = ${current.projectId}` : sql`project_id is null`})
          and ends_at >= least(obs_at.at, ${now.toISOString()}::timestamptz)
          and starts_at <= greatest(obs_at.at, ${now.toISOString()}::timestamptz)
          and (cardinality(monitor_ids) = 0 or ${current.id} = any(monitor_ids))
      ),
      hb as (
        ${needLastHb
          ? sql`select revision as hb_rev, state as hb_state, valid_until as hb_valid from monitor_observation where monitor_id = ${current.id} order by observed_at desc, id desc limit 1`
          : sql`select null::integer as hb_rev, null::text as hb_state, null::timestamptz as hb_valid`}
      )
      select obs_at.at, latest.at as last, maint.maint_until, maint.in_maint, hb.hb_rev, hb.hb_state, hb.hb_valid
      from obs_at, latest, maint left join hb on true`));
    const at = new Date(ctx.at);
    if (needLastHb && ctx.hb_rev === current.coverageRevision && (ctx.hb_state === "up" || ctx.hb_state === "degraded") && ctx.hb_valid && new Date(ctx.hb_valid) > at) {
      return { accepted: false };
    }

    const durationMs = current.type === "heartbeat" ? (current.intervalSec + current.graceSec) * 1000 : current.intervalSec * 1000 + current.timeoutMs + 60_000;
    const obsState = !result.ok ? "down" : result.degraded || (result.latencyMs != null && result.latencyMs > current.slowThresholdMs) ? "degraded" : "up";
    const validUntil = new Date(at.getTime() + durationMs).toISOString();
    const maintUntil = ctx.maint_until ? new Date(ctx.maint_until).toISOString() : null;
    const rowsJson = JSON.stringify(results.map((r) => ({ region: r.region ?? "auto", ok: r.ok, statusCode: r.statusCode ?? null, latencyMs: r.latencyMs ?? null, error: r.error ?? null })));
    const expiryJson = result.domainExpiry ? JSON.stringify(result.domainExpiry) : null;
    const inMaint = !!ctx.in_maint;
    const t = evaluateTransition(current, result, inMaint, !!row.parentDown);
    const suppressed = inMaint && !result.ok;

    await tx.execute(sql`
      with obs as (
        insert into monitor_observation (monitor_id, observed_at, state, valid_until, maintenance_until, revision, generation, interval_sec, grace_sec, timeout_ms)
        values (${current.id}, ${at.toISOString()}::timestamptz, ${obsState}, ${validUntil}::timestamptz, ${maintUntil}::timestamptz, ${current.coverageRevision}, ${generation ?? null}, ${current.intervalSec}, ${current.graceSec}, ${current.timeoutMs})
      ),
      res as (
        insert into check_result (monitor_id, region, ok, status_code, latency_ms, error)
        select ${current.id}, coalesce(r->>'region', 'auto'), (r->>'ok')::boolean, (r->>'statusCode')::integer, (r->>'latencyMs')::integer, r->>'error'
        from jsonb_array_elements(${rowsJson}::jsonb) as r
      ),
      roll as (
        insert into check_rollup (monitor_id, bucket, total, ok, latency_sum, latency_n)
        values (${current.id}, date_trunc('hour', ${now.toISOString()}::timestamptz), 1, ${result.ok ? 1 : 0}, ${result.latencyMs ?? 0}, ${result.latencyMs == null ? 0 : 1})
        on conflict (monitor_id, bucket) do update set
          total = check_rollup.total + 1,
          ok = check_rollup.ok + excluded.ok,
          latency_sum = check_rollup.latency_sum + excluded.latency_sum,
          latency_n = check_rollup.latency_n + excluded.latency_n
      )
      update monitor set
        ${generation !== undefined ? sql`coverage_generation = ${generation},` : sql``}
        ${expiryJson ? sql`domain_expiry = ${expiryJson}::jsonb,` : sql``}
        consecutive_successes = ${t.successes},
        ${suppressed ? sql`` : sql`
          consecutive_failures = ${t.failures},
          ${t.pending ? sql`` : sql`
            status = ${t.nextStatus}::monitor_status,
            status_changed_at = case when status is distinct from ${t.nextStatus}::monitor_status then now() else status_changed_at end,
            consecutive_slow = ${t.finalSlow},`}
        `}
        ${current.type === "heartbeat"
          ? sql`next_check_at = now() + make_interval(secs => ${current.intervalSec + current.graceSec})`
          : sql`last_checked_at = ${now.toISOString()}::timestamptz`}
      where id = ${current.id}`);

    if (suppressed) return { accepted: true, suppressedMaintenance: true };
    return {
      accepted: true, suppressedMaintenance: false, inMaintenance: inMaint, parentDown: !!row.parentDown,
      wantsSlowIncident: t.wantsSlowIncident, goingDown: t.goingDown, recovering: t.recovering,
      opensOutage: t.opensOutage, slowTrips: t.slowTrips, slowClears: t.slowClears,
      checkLateOpen: t.checkLateOpen, pending: t.pending, nextStatus: t.nextStatus, finalSlow: t.finalSlow,
    };
  });
}

/** Single-round-trip check persistence via PL/pgSQL RPC, falling back transparently if unmigrated. */
export async function recordCheckOutcome(
  db: Db,
  snapshot: Monitor,
  result: CheckInput,
  results: RegionResult[],
  options: { generation?: number } = {},
): Promise<CheckOutcomeRow> {
  const completedAt = new Date();
  if (Date.now() >= rpcUnavailableUntil) {
    const rowsJson = JSON.stringify(results.map((r) => ({ region: r.region ?? "auto", ok: r.ok, statusCode: r.statusCode ?? null, latencyMs: r.latencyMs ?? null, error: r.error ?? null })));
    const expiryJson = result.domainExpiry ? JSON.stringify(result.domainExpiry) : null;
    try {
      const [row] = await db.execute<{ res: unknown }>(sql`
        select openuptime_record_check(
          ${snapshot.id}::uuid, ${completedAt.toISOString()}::timestamptz, ${result.ok},
          ${result.latencyMs ?? null}::integer, ${!!result.degraded}, ${options.generation ?? null}::integer,
          ${snapshot.coverageRevision ?? 0}::integer, ${snapshot.coverageHeartbeatVersion ?? 0}::integer,
          ${!!result.domainExpiry}, ${expiryJson}::jsonb, ${snapshot.target}, ${snapshot.domainExpiryWarnDays ?? 30}::integer,
          ${rowsJson}::jsonb
        ) as res`);
      return parseJson<CheckOutcomeRow>(row.res);
    } catch (e) {
      if (!isUndefinedFunction(e)) throw e;
      rpcUnavailableUntil = Date.now() + RPC_RETRY_MS;
    }
  }
  return recordCheckOutcomeFallback(db, snapshot, result, results, options, completedAt);
}

/** Single-round-trip heartbeat ping persistence via PL/pgSQL RPC, falling back transparently if unmigrated. */
export async function recordHeartbeatOutcome(db: Db, snapshot: Monitor): Promise<Monitor | null> {
  const completedAt = new Date();
  if (Date.now() >= rpcUnavailableUntil) {
    try {
      const [row] = await db.execute<{ res: unknown }>(sql`
        select openuptime_record_heartbeat(${snapshot.id}::uuid, ${completedAt.toISOString()}::timestamptz) as res`);
      if (!row?.res) return null;
      const patch = parseJson<Record<string, unknown>>(row.res);
      return {
        ...snapshot,
        status: patch.status as MonitorStatus,
        consecutiveSuccesses: Number(patch.consecutiveSuccesses ?? 0),
        recoveryThreshold: Number(patch.recoveryThreshold ?? snapshot.recoveryThreshold ?? 1),
        intervalSec: Number(patch.intervalSec ?? snapshot.intervalSec),
        graceSec: Number(patch.graceSec ?? snapshot.graceSec),
        coverageHeartbeatVersion: Number(patch.coverageHeartbeatVersion ?? 0),
        consecutiveFailures: 0,
        lastCheckedAt: patch.lastCheckedAt ? new Date(String(patch.lastCheckedAt)) : completedAt,
        nextCheckAt: new Date(String(patch.nextCheckAt)),
      };
    } catch (e) {
      if (!isUndefinedFunction(e)) throw e;
      rpcUnavailableUntil = Date.now() + RPC_RETRY_MS;
    }
  }
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(schema.monitor).where(eq(schema.monitor.id, snapshot.id)).for("update");
    if (!current || current.paused || current.type !== "heartbeat") return null;
    const [ctx] = (await tx.execute<{ at: Date | string; maint_until: Date | string | null }>(sql`
      with clock as materialized (select date_trunc('milliseconds', clock_timestamp()) as at),
      moved as (
        update monitor_observation o set observed_at = clock.at,
          valid_until = case when o.valid_until is null then null else o.valid_until - (o.observed_at - clock.at) end
        from clock where o.monitor_id = ${current.id} and o.observed_at > clock.at
      ),
      latest as (select max(observed_at) as at from monitor_observation where monitor_id = ${current.id}),
      obs_at as (
        select case when latest.at is null then least(${completedAt.toISOString()}::timestamptz, clock.at)
          else greatest(least(${completedAt.toISOString()}::timestamptz, clock.at), least(latest.at, clock.at)) end as at
        from clock, latest
      ),
      maint as (
        select max(ends_at) as maint_until from maintenance_window, obs_at
        where organization_id = ${current.organizationId}
          and (${current.projectId ? sql`project_id is null or project_id = ${current.projectId}` : sql`project_id is null`})
          and starts_at <= obs_at.at and ends_at > obs_at.at
          and (cardinality(monitor_ids) = 0 or ${current.id} = any(monitor_ids))
      )
      select obs_at.at, maint.maint_until from obs_at, maint`));
    const at = new Date(ctx.at);
    const validUntil = new Date(at.getTime() + (current.intervalSec + current.graceSec) * 1000).toISOString();
    const maintUntil = ctx.maint_until ? new Date(ctx.maint_until).toISOString() : null;
    const [updated] = (await tx.execute<{ status: MonitorStatus; consecutive_successes: number; recovery_threshold: number; interval_sec: number; grace_sec: number; coverage_heartbeat_version: number; last_checked_at: Date | string; next_check_at: Date | string }>(sql`
      with obs as (
        insert into monitor_observation (monitor_id, observed_at, state, valid_until, maintenance_until, revision, generation, interval_sec, grace_sec, timeout_ms)
        values (${current.id}, ${at.toISOString()}::timestamptz, 'up', ${validUntil}::timestamptz, ${maintUntil}::timestamptz, ${current.coverageRevision}, null, ${current.intervalSec}, ${current.graceSec}, ${current.timeoutMs})
      ),
      res as (insert into check_result (monitor_id, region, ok) values (${current.id}, 'auto', true)),
      roll as (
        insert into check_rollup (monitor_id, bucket, total, ok, latency_sum, latency_n)
        values (${current.id}, date_trunc('hour', clock_timestamp()), 1, 1, 0, 0)
        on conflict (monitor_id, bucket) do update set total = check_rollup.total + 1, ok = check_rollup.ok + 1
      )
      update monitor set
        coverage_heartbeat_version = ${current.coverageHeartbeatVersion + 1},
        consecutive_successes = least(${current.consecutiveSuccesses + 1}, ${current.recoveryThreshold}),
        consecutive_failures = 0,
        last_checked_at = ${at.toISOString()}::timestamptz,
        next_check_at = clock_timestamp() + make_interval(secs => ${current.intervalSec + current.graceSec}),
        status = ${current.status === "down" ? sql`'down'::monitor_status` : sql`'up'::monitor_status`},
        status_changed_at = ${current.status !== "down" && current.status !== "up" ? sql`${at.toISOString()}::timestamptz` : sql`status_changed_at`}
      where id = ${current.id}
      returning status, consecutive_successes, recovery_threshold, interval_sec, grace_sec, coverage_heartbeat_version, last_checked_at, next_check_at`));
    return {
      ...current,
      status: updated.status,
      consecutiveSuccesses: Number(updated.consecutive_successes),
      recoveryThreshold: Number(updated.recovery_threshold),
      intervalSec: Number(updated.interval_sec),
      graceSec: Number(updated.grace_sec),
      coverageHeartbeatVersion: Number(updated.coverage_heartbeat_version),
      consecutiveFailures: 0,
      lastCheckedAt: new Date(updated.last_checked_at),
      nextCheckAt: new Date(updated.next_check_at),
    };
  });
}

/** Aggregate in PostgreSQL, avoiding a month's raw observations in Worker memory. */
export async function timeCoverage(db: Db, orgId: string, monitorId: string, scope: Scope, days: 7 | 30, now = new Date()): Promise<TimeCoverage | null> {
  if (days !== 7 && days !== 30) throw new Error("Coverage window must be 7 or 30 days");
  const [m] = await db.select({ id: schema.monitor.id }).from(schema.monitor).where(and(eq(schema.monitor.id, monitorId), eq(schema.monitor.organizationId, orgId), scope ? inArray(schema.monitor.projectId, scope) : undefined));
  if (!m) return null;
  const from = new Date(now.getTime() - days * 86_400_000);
  const values = await db.execute(sql`
    with events as (
      (select * from monitor_observation where monitor_id = ${monitorId} and observed_at < ${from.toISOString()} order by observed_at desc, id desc limit 1)
      union all
      (select * from monitor_observation where monitor_id = ${monitorId} and observed_at >= ${from.toISOString()} and observed_at < ${now.toISOString()})
    ), spans as (
      select state, maintenance_until, greatest(observed_at, ${from.toISOString()}::timestamptz) as lo,
        least(lead(observed_at, 1, ${now.toISOString()}::timestamptz) over (order by observed_at, id), coalesce(valid_until, ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz) as hi
      from events
    ) select state, coalesce(sum(greatest(0, extract(epoch from (hi-lo)) * 1000)), 0)::double precision as ms,
      coalesce(sum(case when maintenance_until is not null then greatest(0, extract(epoch from (least(hi, maintenance_until)-lo)) * 1000) else 0 end), 0)::double precision as maintenance_ms
      from spans group by state`);
  const totalMs = now.getTime() - from.getTime();
  const states = { up: 0, down: 0, degraded: 0, paused: 0, unknown: 0 };
  let observedMaintenanceMs = 0;
  for (const row of values) {
    const state = String(row.state);
    if (state === "up" || state === "down" || state === "degraded" || state === "paused") states[state] = Number(row.ms);
    observedMaintenanceMs += Number(row.maintenance_ms);
  }
  // Everything without a still-valid observation is unknown, including time before this feature was deployed.
  states.unknown = Math.max(0, totalMs - states.up - states.down - states.degraded - states.paused);
  return { from: from.toISOString(), to: now.toISOString(), totalMs, states, observedMaintenanceMs, policy: "bounded-observation-v1" };
}
