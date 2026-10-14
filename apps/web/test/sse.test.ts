import type { RecordList } from "@dit/contract";
import { batching, events, records } from "@dit/contract/fixtures";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { endpointKey } from "../lib/queries.ts";
import { applyServerEvent, parseSseChunk } from "../lib/sse.tsx";
import { syncEtaLabel } from "../lib/time.ts";

describe("server events", () => {
  it("parses SSE frames and keeps partial frames for the next chunk", () => {
    const text = `event: ping\ndata: ${JSON.stringify(events.ping)}\n\nevent: record.sync\ndata: {"type":"rec`;
    const { events: parsed, rest } = parseSseChunk(text);
    expect(parsed).toEqual([events.ping]);
    expect(rest).toContain('"type":"rec');
  });

  it("flips a pending record to synced in the query cache and announces it", () => {
    const client = new QueryClient();
    const key = endpointKey("listRecords", { params: { name: "alice" } });
    client.setQueryData<RecordList>(key, { items: [records.CNAME], usage: { used: 1, limit: 10 } });
    const message = applyServerEvent(client, events["record.sync"]);
    expect(client.getQueryData<RecordList>(key)?.items[0]?.syncStatus).toBe("synced");
    expect(message).toBe("www CNAME 已同步");
  });

  it("keeps the expected sync time of a batched DNS write until it is synced", () => {
    const client = new QueryClient();
    const key = endpointKey("listRecords", { params: { name: "alice" } });
    client.setQueryData<RecordList>(key, { items: [records.CNAME], usage: { used: 1, limit: 10 } });
    applyServerEvent(client, batching.event);
    expect(client.getQueryData<RecordList>(key)?.items[0]?.syncEta).toBe(batching.event.syncEta);
    applyServerEvent(client, events["record.sync"]);
    expect(client.getQueryData<RecordList>(key)?.items[0]?.syncEta).toBeUndefined();
  });

  it("labels the expected sync time in Taipei time", () => {
    const now = Date.parse("2026-10-14T09:00:00.000Z");
    expect(syncEtaLabel("2026-10-14T09:18:00.000Z", now)).toBe("預計 17:18 前生效");
    expect(syncEtaLabel("2026-10-15T00:01:00.000Z", now)).toMatch(
      /^預計 2026\/10\/15 08:01 前生效$/,
    );
  });

  it("ignores sync events for an older version", () => {
    const client = new QueryClient();
    const key = endpointKey("listRecords", { params: { name: "alice" } });
    client.setQueryData<RecordList>(key, {
      items: [{ ...records.CNAME, version: 5 }],
      usage: { used: 1, limit: 10 },
    });
    applyServerEvent(client, events["record.sync"]);
    expect(client.getQueryData<RecordList>(key)?.items[0]?.syncStatus).toBe("pending");
  });

  it("removes deleted records", () => {
    const client = new QueryClient();
    const key = endpointKey("listRecords", { params: { name: "alice" } });
    client.setQueryData<RecordList>(key, {
      items: [records.SRV, records.A],
      usage: { used: 2, limit: 10 },
    });
    applyServerEvent(client, events["record.deleted"]);
    expect(client.getQueryData<RecordList>(key)).toEqual({
      items: [records.A],
      usage: { used: 1, limit: 10 },
    });
  });
});
