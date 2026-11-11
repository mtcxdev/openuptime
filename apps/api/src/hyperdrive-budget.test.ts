import { Hono } from "hono";
import type { Monitor, Repo } from "@openuptime/repo";
import { createRepo, resetBatchRpcCache } from "@openuptime/db-pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./env";
import { createApp } from "./app";
import { requireManager, requireOrg } from "./middleware";
import { checkOne, runDueChecks } from "./scheduler";

const monitorFixture = (over: Partial<Monitor> = {}): Monitor => ({
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  projectId: "proj-1",
  name: "API",
  type: "heartbeat",
  target: "",
  method: "GET",
  expectedStatus: 200,
  intervalSec: 60,
  timeoutMs: 10000,
  failureThreshold: 3,
  recoveryThreshold: 1,
  consecutiveSuccesses: 0,
  regions: ["auto"],
  status: "up",
  consecutiveFailures: 0,
  lastCheckedAt: null,
  nextCheckAt: new Date("2026-11-11T12:00:00Z"),
  runGeneration: 3,
  coverageRevision: 1,
  coverageHeartbeatVersion: 2,
  paused: false,
  heartbeatToken: "hb-token-1234567890",
  keyword: null,
  keywordMode: "contains",
  expectedLocation: null,
  headers: {},
  wsMessage: null,
  graceSec: 60,
  channelIds: [],
  tags: [],
  slowThresholdMs: 1500,
  slowAlertAfter: 0,
  consecutiveSlow: 0,
  dependsOnMonitorId: null,
  minRegionsFailing: 0,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  ...over,
});

afterEach(() => {
  resetBatchRpcCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("db-pg single-call RPC & fallback", () => {
  it("commits a check in 1 execute call via openuptime_record_check", async () => {
    const execute = vi.fn(async () => [{ res: { accepted: true, pending: false, checkLateOpen: false } }]);
    const repo = createRepo({ execute } as never);
    const out = await repo.recordCheckOutcome!(
      monitorFixture({ type: "http", target: "https://example.com" }),
      { ok: true, statusCode: 200, latencyMs: 42 },
      [{ region: "auto", ok: true, statusCode: 200, latencyMs: 42, error: null }],
      { generation: 3 },
    );
    expect(out).toMatchObject({ accepted: true, pending: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("falls back to batched transaction queries on 42883 and caches unavailability", async () => {
    resetBatchRpcCache();
    let rpcCalls = 0;
    let txCalls = 0;
    const fakeTx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: async () => [{
              monitor: {
                id: "11111111-1111-4111-8111-111111111111",
                organizationId: "org-1",
                projectId: "proj-1",
                type: "http",
                target: "https://example.com",
                domainExpiryWarnDays: 30,
                intervalSec: 60,
                timeoutMs: 10000,
                failureThreshold: 3,
                recoveryThreshold: 1,
                consecutiveSuccesses: 0,
                status: "up",
                consecutiveFailures: 0,
                runGeneration: 3,
                coverageRevision: 1,
                coverageGeneration: 0,
                coverageHeartbeatVersion: 0,
                paused: false,
                graceSec: 0,
                slowThresholdMs: 1500,
                slowAlertAfter: 0,
                consecutiveSlow: 0,
                dependsOnMonitorId: null,
              },
              parentDown: false,
            }],
          }),
        }),
      }),
      execute: vi.fn(async () => {
        txCalls += 1;
        return [{ at: "2026-11-11T12:00:00Z", maint_until: null, in_maint: false }];
      }),
    };
    const db = {
      execute: vi.fn(async () => {
        rpcCalls += 1;
        throw Object.assign(new Error("function openuptime_record_check does not exist"), { code: "42883" });
      }),
      transaction: vi.fn(async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx)),
    };
    const repo = createRepo(db as never);
    const m = monitorFixture({ type: "http", target: "https://example.com" });

    const first = await repo.recordCheckOutcome!(m, { ok: true, latencyMs: 30 }, [{ region: "auto", ok: true, latencyMs: 30 }], { generation: 3 });
    expect(first).toMatchObject({ accepted: true, pending: false, suppressedMaintenance: false });
    expect(rpcCalls).toBe(1);
    expect(txCalls).toBe(2);

    // Second call while cached unavailable should skip the failing RPC completely.
    const second = await repo.recordCheckOutcome!(m, { ok: true, latencyMs: 31 }, [{ region: "auto", ok: true, latencyMs: 31 }], { generation: 3 });
    expect(second).toMatchObject({ accepted: true, pending: false });
    expect(rpcCalls).toBe(1);
    expect(txCalls).toBe(4);
  });

  it("commits a heartbeat ping in 1 execute call and restores Date objects", async () => {
    const execute = vi.fn(async () => [{
      res: {
        status: "up",
        consecutiveSuccesses: 1,
        recoveryThreshold: 1,
        intervalSec: 60,
        graceSec: 60,
        coverageHeartbeatVersion: 3,
        lastCheckedAt: "2026-11-11T12:01:00.000Z",
        nextCheckAt: "2026-11-11T12:03:00.000Z",
      },
    }]);
    const repo = createRepo({ execute } as never);
    const updated = await repo.recordHeartbeatOutcome!(monitorFixture());
    expect(updated).not.toBeNull();
    expect(updated!.coverageHeartbeatVersion).toBe(3);
    expect(updated!.lastCheckedAt).toBeInstanceOf(Date);
    expect(updated!.nextCheckAt).toBeInstanceOf(Date);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("checks recovery progress in 1 query even for healthy monitors", async () => {
    const execute = vi.fn(async () => [{ paused: false, successes: 0, threshold: 2 }]);
    const repo = createRepo({ execute } as never);
    expect(await repo.recordRecoveryProgress(monitorFixture({ status: "up" }), true)).toEqual({ successes: 0, ready: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("scheduler and route query efficiency", () => {
  it("uses recordCheckOutcome without legacy calls on steady-state checks", async () => {
    const recordCheckOutcome = vi.fn(async () => ({ accepted: true, suppressedMaintenance: false, pending: false, checkLateOpen: false }));
    const forbidden = vi.fn(async () => { throw new Error("unexpected legacy repo call"); });
    const repo = {
      recordCheckOutcome,
      recordObservation: forbidden,
      underMaintenance: forbidden,
      recordCheck: forbidden,
      recordRegionResults: forbidden,
      recordRecoveryProgress: forbidden,
      setMonitorState: forbidden,
      monitorsByIds: forbidden,
    } as unknown as Repo;

    await checkOne(repo, monitorFixture({ type: "heartbeat" }));
    expect(recordCheckOutcome).toHaveBeenCalledTimes(1);
  });

  it("handles maintenance suppression cleanly through recordCheckOutcome", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const recordCheckOutcome = vi.fn(async () => ({ accepted: true, suppressedMaintenance: true }));
    const openAutoIncident = vi.fn();
    const repo = { recordCheckOutcome, openAutoIncident } as unknown as Repo;
    await checkOne(repo, monitorFixture({ type: "heartbeat" }));
    expect(openAutoIncident).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("suppressed: maintenance"));
  });

  it("skips maintenance reminders when pendingHousekeeping clears them and throttles purgeExpired to every 6h", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const claimRemindersCall = vi.fn(async () => []);
      const purgeExpired = vi.fn(async () => {});
      const repo = {
        claimDue: async () => [],
        pendingHousekeeping: async () => ({ mcpAlerts: false, deliveries: false, followUps: false, maintenanceReminders: false }),
        claimMaintenanceReminders: claimRemindersCall,
        claimMonthlyReports: vi.fn(async () => []),
        endStuckWork: vi.fn(async () => ({ ended: 0, overdue: 0 })),
        purgeExpired,
      } as unknown as Repo;

      vi.setSystemTime(new Date("2026-11-01T01:05:00Z"));
      await runDueChecks(repo);
      expect(claimRemindersCall).not.toHaveBeenCalled();
      expect(purgeExpired).not.toHaveBeenCalled();
      expect(repo.claimMonthlyReports).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2026-11-01T01:00:00Z"));
      await runDueChecks(repo);
      expect(purgeExpired).not.toHaveBeenCalled();
      expect(repo.claimMonthlyReports).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-11-01T06:00:00Z"));
      await runDueChecks(repo);
      expect(purgeExpired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses recordHeartbeatOutcome on /api/heartbeat/:token without separate recordCheck", async () => {
    const m = monitorFixture();
    const recordHeartbeatOutcome = vi.fn(async () => ({ ...m, status: "up" as const }));
    const recordCheck = vi.fn();
    const app = createApp(() => ({
      repo: { monitorByHeartbeatToken: async () => m, recordHeartbeatOutcome, recordCheck } as unknown as Repo,
      authDatabase: {} as never,
      migrate: async () => [],
      query: async () => [],
      close: async () => {},
    }));
    const res = await app.fetch(new Request(`http://localhost/api/heartbeat/${m.heartbeatToken}`, { method: "POST" }), {
      DATABASE_URL: "postgres://u:p@localhost/db",
      BETTER_AUTH_SECRET: "secret-secret-secret-secret-secret",
      BETTER_AUTH_URL: "http://localhost",
      WEB_ORIGIN: "http://localhost",
    } as never);
    expect(res.status).toBe(200);
    expect(recordHeartbeatOutcome).toHaveBeenCalledTimes(1);
    expect(recordCheck).not.toHaveBeenCalled();
  });

  it("checks memberRole once across requireOrg and requireManager", async () => {
    const memberRole = vi.fn(async () => "admin");
    const isMember = vi.fn(async () => true);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("repo", { memberRole, isMember, resolveProject: async () => "proj-1" } as unknown as Repo);
      c.set("auth", { api: { getSession: async () => ({ user: { id: "u1", emailVerified: true }, session: { activeOrganizationId: "org-1" } }) } } as never);
      await next();
    });
    app.use("*", requireOrg);
    app.delete("/test", requireManager, (c) => c.json({ ok: true }));
    const res = await app.request("/test", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(memberRole).toHaveBeenCalledTimes(1);
    expect(isMember).not.toHaveBeenCalled();
  });

  it("shares boardCache and caches maintenance, rss, ics, and llms public feeds", async () => {
    vi.stubEnv("VITEST", "");
    vi.resetModules();
    const { publicStatus, purgePublicStatus } = await import("./routes/status");
    const statusPageBySlug = vi.fn(async (slug: string) => ({
      id: "page-1", organizationId: "org-1", projectId: "proj-1", slug, title: "MTCX",
      theme: "auto", showLatency: true, externalUrl: "https://mtcx.store", hideBranding: false,
      uptimeOkPct: 99.9, uptimeWarnPct: 98, mcpEnabled: true, maintenanceReminderHours: 24, createdAt: new Date(),
    }));
    const statusBoard = vi.fn(async () => ({ bucket: "day", components: [{ id: "m1", name: "API", group: null, status: "up", uptime90d: 100, days: [] }], incidents: [] }));
    const pageMaintenance = vi.fn(async () => []);
    const pageIncidents = vi.fn(async () => []);

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("repo", { statusPageBySlug, statusBoard, pageMaintenance, pageIncidents } as unknown as Repo);
      c.set("entitlements", { plan: async () => null } as never);
      await next();
    });
    app.route("/api/public/status", publicStatus);

    expect((await app.request("/api/public/status/mtcx")).status).toBe(200);
    expect((await app.request("/api/public/status/mtcx/summary")).status).toBe(200);
    expect((await app.request("/api/public/status/mtcx/badge.svg")).status).toBe(200);
    expect((await app.request("/api/public/status/mtcx/summary")).status).toBe(200);
    expect(statusBoard).toHaveBeenCalledTimes(1);

    expect((await app.request("/api/public/status/mtcx/maintenance")).status).toBe(200);
    expect((await app.request("/api/public/status/mtcx/maintenance")).status).toBe(200);
    expect(pageMaintenance).toHaveBeenCalledTimes(1);

    expect((await app.request("/api/public/status/mtcx/rss.xml")).status).toBe(200);
    expect((await app.request("/api/public/status/mtcx/rss.xml")).status).toBe(200);
    expect(pageIncidents).toHaveBeenCalledTimes(1);

    purgePublicStatus();
    expect((await app.request("/api/public/status/mtcx/summary")).status).toBe(200);
    expect(statusBoard).toHaveBeenCalledTimes(2);
  });
});
