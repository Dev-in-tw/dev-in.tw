"use client";

import type { DnsRecord, RecordList, ServerEvent } from "@dit/contract";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { t } from "./i18n/zh-Hant.ts";
import { endpointKey } from "./queries.ts";

/**
 * 即時同步狀態（PLAN §5.4）：讀 `GET /api/v1/events` 的 SSE，依 ServerEvent 更新 Query cache。
 *
 * 用 fetch 串流自己解析 SSE（而不是 EventSource）：這樣才看得到 HTTP 狀態碼，
 * 遇到 501 NOT_IMPLEMENTED（P1 尚未完成）就改成每 3 秒輪詢 pending 的紀錄；
 * 斷線時以指數退避（1s → 30s）重連。
 */
export type SyncMode = "connecting" | "live" | "polling" | "offline";

interface SyncContextValue {
  mode: SyncMode;
  announce: string;
  /** 最近剛同步完成的紀錄 id（給列的閃一下動畫用） */
  justSynced: ReadonlySet<string>;
}

const SyncContext = createContext<SyncContextValue>({
  mode: "offline",
  announce: "",
  justSynced: new Set(),
});

export function parseSseChunk(buffer: string): { events: ServerEvent[]; rest: string } {
  const events: ServerEvent[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as ServerEvent);
    } catch {
      // 忽略壞掉的事件
    }
  }
  return { events, rest };
}

function recordLabel(r: DnsRecord): string {
  return `${r.name === "@" ? "根網域" : r.name} ${r.type}`;
}

export function applyServerEvent(client: QueryClient, event: ServerEvent): string | null {
  switch (event.type) {
    case "record.sync": {
      const key = endpointKey("listRecords", { params: { name: event.subdomain } });
      let message: string | null = null;
      client.setQueryData<RecordList>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((r) => {
            if (r.id !== event.recordId || r.version > event.version) return r;
            if (event.syncStatus === "synced") message = `${recordLabel(r)} 已同步`;
            if (event.syncStatus === "error") message = `${recordLabel(r)} 同步失敗`;
            // 批次寫入時 pending 帶預計生效時間；同步完成或失敗後就不再顯示
            const waiting = event.syncStatus === "pending" || event.syncStatus === "deleting";
            return {
              ...r,
              syncStatus: event.syncStatus,
              syncError: event.syncError,
              syncEta: waiting ? (event.syncEta ?? r.syncEta) : undefined,
            };
          }),
        };
      });
      return message;
    }
    case "record.deleted": {
      const key = endpointKey("listRecords", { params: { name: event.subdomain } });
      client.setQueryData<RecordList>(key, (old) =>
        old
          ? {
              ...old,
              items: old.items.filter((r) => r.id !== event.recordId),
              usage: { ...old.usage, used: Math.max(0, old.usage.used - 1) },
            }
          : old,
      );
      return "紀錄已刪除";
    }
    case "subdomain.status":
      client.invalidateQueries({ queryKey: ["getSubdomain"] });
      client.invalidateQueries({ queryKey: ["listSubdomains"] });
      return `${event.subdomain} 的狀態變成「${t.subdomainStatusSpoken[event.status]}」`;
    case "transfer.updated":
      client.invalidateQueries({ queryKey: ["listTransfers"] });
      client.invalidateQueries({ queryKey: ["listSubdomains"] });
      return null;
    case "ping":
      return null;
  }
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [mode, setMode] = useState<SyncMode>("connecting");
  const [announce, setAnnounce] = useState("");
  const [justSynced, setJustSynced] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const flash = (id: string) => {
      setJustSynced((prev) => new Set(prev).add(id));
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => {
          setJustSynced((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }, 1200),
      );
    };

    const connect = async () => {
      controller = new AbortController();
      try {
        const res = await fetch("/api/v1/events", {
          headers: { Accept: "text/event-stream" },
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (res.status === 501) {
          setMode("polling");
          return; // P1 尚未實作：改用輪詢，不再重連
        }
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        setMode("live");
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsed = parseSseChunk(buffer + value);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            const message = applyServerEvent(client, event);
            if (event.type === "record.sync" && event.syncStatus === "synced")
              flash(event.recordId);
            if (message) setAnnounce(message);
          }
        }
        throw new Error("stream closed");
      } catch {
        if (stopped) return;
        setMode("offline");
        const delay = Math.min(30_000, 1000 * 2 ** attempt);
        attempt += 1;
        retry = setTimeout(connect, delay);
      }
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      controller?.abort();
    };
  }, [client]);

  return (
    <SyncContext value={{ mode, announce, justSynced }}>
      {children}
      <p className="sr-only" aria-live="polite" data-testid="sync-live">
        {announce}
      </p>
    </SyncContext>
  );
}

export function useSync(): SyncContextValue {
  return useContext(SyncContext);
}
