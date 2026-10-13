"use client";

import type { AuditEvent } from "@dit/contract";
import { useDeferredValue, useState } from "react";
import { actionLabel } from "@/components/app/activity.tsx";
import { Input, Select } from "@/components/ui/field.tsx";
import { formatDateTime } from "@/lib/time.ts";
import { Chip, DataTable, ListState, useAdminList } from "./common.tsx";

export function AdminAudit() {
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const a = useDeferredValue(action.trim());
  const list = useAdminList("adminAuditLog", {
    ...(a ? { action: a } : {}),
    ...(targetType ? { targetType } : {}),
  });
  const items = (list.data?.pages.flatMap((p) => p.items) ?? []) as AuditEvent[];
  return (
    <div>
      <h1 className="text-step-3 font-semibold tracking-tight">稽核紀錄</h1>
      <div className="mt-5 flex flex-wrap gap-3">
        <label htmlFor="audit-action" className="sr-only">
          動作
        </label>
        <Input
          id="audit-action"
          data-search
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="動作，例如 record. 或 subdomain.suspend"
          className="zone max-w-sm"
        />
        <label htmlFor="audit-target" className="sr-only">
          對象類型
        </label>
        <Select
          id="audit-target"
          value={targetType}
          onChange={(e) => setTargetType(e.target.value)}
          className="w-40"
        >
          <option value="">所有對象</option>
          {[
            "user",
            "subdomain",
            "record",
            "transfer",
            "report",
            "reserved",
            "zone",
            "settings",
            "session",
          ].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      <div className="mt-5">
        <ListState query={list} empty={items.length === 0}>
          <DataTable label="稽核紀錄" head={["時間", "動作", "對象", "操作者", "細節"]}>
            {items.map((e) => (
              <tr key={e.id} className="align-top hover:bg-surface">
                <td className="zone px-3 py-2.5 whitespace-nowrap text-ink-muted">
                  {formatDateTime(e.createdAt)}
                </td>
                <td className="px-3 py-2.5">
                  <span className="block">{actionLabel(e.action)}</span>
                  <span className="zone text-xs text-ink-muted">{e.action}</span>
                </td>
                <td className="zone px-3 py-2.5">
                  <Chip>{e.target.type}</Chip> {e.target.label}
                </td>
                <td className="zone px-3 py-2.5">
                  {e.actor ? (
                    `@${e.actor.githubLogin}`
                  ) : (
                    <span className="text-ink-muted">系統</span>
                  )}
                </td>
                <td
                  className="zone max-w-xs truncate px-3 py-2.5 text-xs text-ink-muted"
                  title={JSON.stringify(e.metadata)}
                >
                  {JSON.stringify(e.metadata)}
                </td>
              </tr>
            ))}
          </DataTable>
        </ListState>
      </div>
    </div>
  );
}
