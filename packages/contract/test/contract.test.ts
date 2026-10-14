import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  availability,
  batching,
  events,
  presets,
  problems,
  records,
  requests,
  responses,
  subdomains,
} from "../src/fixtures.ts";
import {
  Availability as AvailabilitySchema,
  AvailabilityStatus,
  DnsRecord,
  type Endpoint,
  ERROR_STATUS,
  ErrorCode,
  endpoints,
  Hostname,
  Problem,
  RecordName,
  RecordType,
  ServerEvent,
  Subdomain,
  SubdomainLabel,
  SubdomainName,
  SubdomainStatus,
  SyncStatus,
} from "../src/index.ts";

const entries = Object.entries(endpoints) as [string, Endpoint][];

describe("endpoint map", () => {
  it("has unique method + path pairs (path parameters normalized)", () => {
    const keys = entries.map(([, ep]) => `${ep.method} ${ep.path.replace(/\{\w+\}/g, "{}")}`);
    const duplicates = keys.filter((key, i) => keys.indexOf(key) !== i);
    expect(duplicates).toEqual([]);
  });

  it.each(entries)("%s: path parameters match the params schema", (_, ep) => {
    const inPath = [...ep.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const inSchema = Object.keys(ep.params?.shape ?? {}).sort();
    expect(inPath).toEqual(inSchema);
  });

  it.each(entries)("%s: response is null exactly for 204, redirects and SSE", (name, ep) => {
    const noBody = ep.status === 204 || ep.status === 302 || ep.status === 303 || name === "events";
    // deleteMe and adminReconcile acknowledge with 202 and no body
    const ackWithoutBody = name === "deleteMe" || name === "adminReconcile";
    expect(ep.response === null).toBe(noBody || ackWithoutBody);
  });

  it.each(entries)("%s: only lists known error codes, without duplicates", (_, ep) => {
    for (const code of ep.errors) expect(ErrorCode.options).toContain(code);
    expect(new Set(ep.errors).size).toBe(ep.errors.length);
  });

  it("paths are relative to /api/v1 and never include a version or trailing slash", () => {
    for (const [, ep] of entries) {
      expect(ep.path).toMatch(/^\/[a-z]/);
      expect(ep.path).not.toMatch(/^\/(api|v\d)/);
      expect(ep.path.endsWith("/")).toBe(false);
    }
  });

  it("GET endpoints never declare a body", () => {
    for (const [, ep] of entries) if (ep.method === "GET") expect(ep.body).toBeUndefined();
  });
});

describe("error codes", () => {
  it("every code has an HTTP status in the problem range", () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ErrorCode.options].sort());
    for (const status of Object.values(ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThanOrEqual(599);
    }
  });

  it("problem fixtures parse and use the status mapped to their code", () => {
    for (const problem of Object.values(problems)) {
      const parsed = Problem.parse(problem);
      expect(parsed.status).toBe(ERROR_STATUS[parsed.code]);
    }
  });
});

describe("response fixtures", () => {
  const withResponse = entries.filter(([, ep]) => ep.response !== null);

  it("exist for every endpoint with a JSON response, and only for those", () => {
    expect(Object.keys(responses).sort()).toEqual(withResponse.map(([name]) => name).sort());
  });

  it.each(withResponse)("%s: fixture parses with the response schema", (name, ep) => {
    const fixture = (responses as Record<string, unknown>)[name];
    const result = (ep.response as z.ZodType).safeParse(fixture);
    expect(result.error?.issues ?? []).toEqual([]);
  });
});

describe("request fixtures", () => {
  const withBody = entries.filter(([, ep]) => ep.body !== undefined);

  it("exist for every endpoint with a body", () => {
    expect(Object.keys(requests).sort()).toEqual(withBody.map(([name]) => name).sort());
  });

  it.each(withBody)("%s: fixture parses with the body schema", (name, ep) => {
    const fixture = (requests as Record<string, unknown>)[name];
    const result = (ep.body as z.ZodType).safeParse(fixture);
    expect(result.error?.issues ?? []).toEqual([]);
  });
});

describe("variant fixtures cover every state", () => {
  it("availability: all statuses", () => {
    expect(Object.keys(availability).sort()).toEqual([...AvailabilityStatus.options].sort());
    for (const [status, value] of Object.entries(availability)) {
      expect(AvailabilitySchema.parse(value).status).toBe(status);
    }
  });

  it("subdomain: all statuses", () => {
    expect(Object.keys(subdomains).sort()).toEqual([...SubdomainStatus.options].sort());
    for (const [status, value] of Object.entries(subdomains)) {
      expect(Subdomain.parse(value).status).toBe(status);
    }
  });

  it("records: every type and every sync status", () => {
    expect(Object.keys(records).sort()).toEqual([...RecordType.options].sort());
    const parsed = Object.values(records).map((r) => DnsRecord.parse(r));
    for (const [type, record] of Object.entries(records)) expect(record.type).toBe(type);
    expect(new Set(parsed.map((r) => r.syncStatus))).toEqual(new Set(SyncStatus.options));
  });

  it("events: every server event type", () => {
    const types = ServerEvent.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(events).sort()).toEqual(types);
    for (const [type, value] of Object.entries(events)) {
      expect(ServerEvent.parse(value).type).toBe(type);
    }
  });

  it("batching: the contract-v1.3 fields parse", () => {
    expect(DnsRecord.parse(batching.record).syncEta).toBe(batching.record.syncEta);
    expect(ServerEvent.parse(batching.event)).toMatchObject({ syncEta: batching.event.syncEta });
    expect(endpoints.getStatus.response.parse(batching.getStatus).syncQueue.batching).toEqual(
      batching.getStatus.syncQueue.batching,
    );
    expect(endpoints.adminZone.response.parse(batching.adminZone)).toMatchObject({
      provider: "lazco",
      usageUnit: "rrset",
    });
  });

  it("presets: ids are unique", () => {
    const presetIds = presets.map((p) => p.id);
    expect(new Set(presetIds).size).toBe(presetIds.length);
  });
});

describe("primitives", () => {
  it.each([
    ["alice", true],
    ["a-b", true],
    ["abc123", true],
    ["ab", false], // 1–2 字元保留給 premium
    ["xn--abc", false],
    ["a--b", false],
    ["-abc", false],
    ["abc-", false],
    ["Alice", false],
    ["a_b", false],
    ["a".repeat(32), true],
    ["a".repeat(33), false],
  ])("SubdomainLabel %s → %s", (value, ok) => {
    expect(SubdomainLabel.safeParse(value).success).toBe(ok);
  });

  it.each([
    ["x", true],
    ["a".repeat(63), true],
    ["a".repeat(64), false],
  ])("SubdomainName %s → %s", (value, ok) => {
    expect(SubdomainName.safeParse(value).success).toBe(ok);
  });

  it.each([
    ["@", true],
    ["www", true],
    ["_acme-challenge", true],
    ["_minecraft._tcp", true],
    ["a.b.c", true],
    ["a.b.c.d", false],
    ["*", false],
    ["WWW", false],
    ["www.", false],
  ])("RecordName %s → %s", (value, ok) => {
    expect(RecordName.safeParse(value).success).toBe(ok);
  });

  it.each([
    ["alice.github.io", true],
    ["cname.vercel-dns.com", true],
    ["localhost", false],
    ["1.2.3.4", false],
    ["alice.github.io.", false],
  ])("Hostname %s → %s", (value, ok) => {
    expect(Hostname.safeParse(value).success).toBe(ok);
  });
});
