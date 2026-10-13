// biome-ignore-all lint/a11y/useSemanticElements: zone file 表格用 CSS subgrid 對齊並在手機改成卡片，<table> 做不到，因此用 ARIA table 角色
// biome-ignore-all lint/a11y/useFocusableInteractive: role="row"／"cell" 是表格結構，不是互動元件
"use client";

import type { DnsRecord, RecordType, Subdomain } from "@dit/contract";
import { ChevronDown, Pencil, RotateCw, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { CopyButton } from "@/components/app/copy-button.tsx";
import { SyncBadge } from "@/components/app/status-badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { api, isApiError } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage, fieldErrors } from "@/lib/errors.ts";
import { type FieldErrors, type ValidateContext, validateDraft } from "@/lib/record-validate.ts";
import {
  digCommand,
  draftFromRecord,
  type RecordDraft,
  recordValue,
  ttlLabel,
} from "@/lib/records.ts";
import { useSync } from "@/lib/sse.tsx";
import { RecordFields } from "./record-fields.tsx";

export function RecordRow({
  record,
  subdomain,
  editing,
  deleting,
  highlighted,
  onHover,
  onEdit,
  onCancelEdit,
  onSaved,
  onDelete,
  onRetry,
  validationContext,
  allowedTypes,
  disabled,
  onConflictReload,
}: {
  record: DnsRecord;
  subdomain: Subdomain;
  editing: boolean;
  deleting: boolean;
  highlighted: boolean;
  onHover: (name: string | null) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: (record: DnsRecord) => void;
  onDelete: () => void;
  onRetry: () => void;
  validationContext: ValidateContext;
  allowedTypes: readonly RecordType[];
  disabled: boolean;
  onConflictReload: () => void;
}) {
  const { justSynced } = useSync();
  const [errorOpen, setErrorOpen] = useState(false);
  const prevStatus = useRef(record.syncStatus);
  const [shake, setShake] = useState(false);
  const errorId = useId();
  const isTemp = record.id.startsWith("temp-");
  const struck = deleting || record.syncStatus === "deleting";

  useEffect(() => {
    if (prevStatus.current !== "error" && record.syncStatus === "error") {
      setShake(true);
      const t = setTimeout(() => setShake(false), 400);
      prevStatus.current = record.syncStatus;
      return () => clearTimeout(t);
    }
    prevStatus.current = record.syncStatus;
  }, [record.syncStatus]);

  if (editing) {
    return (
      <EditRow
        record={record}
        subdomain={subdomain}
        onCancel={onCancelEdit}
        onSaved={onSaved}
        validationContext={validationContext}
        allowedTypes={allowedTypes}
        onConflictReload={onConflictReload}
      />
    );
  }

  const value = recordValue(record);
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (disabled || struck || isTemp) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onEdit();
    }
  };

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      role="row"
      onMouseEnter={() => onHover(record.name)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(record.name)}
      onBlur={() => onHover(null)}
      data-testid={`record-${record.name}-${record.type}`}
      data-status={record.syncStatus}
      className={cn(
        "group relative grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 border-b border-rule px-4 py-3 outline-none last:border-b-0 focus-visible:bg-magpie-soft md:col-span-6 md:grid-cols-subgrid md:items-center md:gap-0 md:px-0 md:py-0",
        highlighted && "bg-surface",
        justSynced.has(record.id) && "sync-flash",
        shake && "sync-shake",
      )}
    >
      <span role="cell" className="text-xs text-ink-muted md:hidden">
        NAME
      </span>
      {/* 名稱格是「點列或按 Enter 進入行內編輯」的入口；不讓整列可聚焦，避免和列內按鈕重疊 */}
      <span
        role="cell"
        tabIndex={disabled || struck || isTemp ? undefined : 0}
        onKeyDown={onKey}
        onClick={() => !disabled && !struck && !isTemp && onEdit()}
        aria-label={`${record.name} ${record.type} ${value}，按 Enter 編輯`}
        data-testid="record-name"
        className={cn(
          "min-w-0 cursor-text truncate rounded-sm outline-none focus-visible:bg-magpie-soft focus-visible:ring-2 focus-visible:ring-magpie md:px-3 md:py-2.5",
          struck && "line-through decoration-danger",
        )}
        title={record.fqdn}
      >
        {record.name}
      </span>
      <span role="cell" className="text-xs text-ink-muted md:hidden">
        TTL
      </span>
      <span role="cell" className="text-ink-muted md:px-3 md:py-2.5">
        {ttlLabel(record.ttl)}
      </span>
      <span role="cell" className="text-xs text-ink-muted md:hidden">
        TYPE
      </span>
      <span role="cell" className="font-semibold text-beak md:px-3 md:py-2.5">
        {record.type}
      </span>
      <span role="cell" className="text-xs text-ink-muted md:hidden">
        VALUE
      </span>
      <span role="cell" className="flex min-w-0 items-center gap-1 md:px-3 md:py-1.5">
        <span
          className={cn(
            "min-w-0 truncate text-magpie transition-[text-decoration-color] duration-300",
            struck ? "line-through decoration-danger" : "decoration-transparent",
          )}
          title={value}
        >
          {value}
        </span>
        <CopyButton
          value={value}
          label={`複製 ${record.name} ${record.type} 的值`}
          className="size-7 opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
        />
      </span>
      <span role="cell" className="text-xs text-ink-muted md:hidden">
        STATUS
      </span>
      <span role="cell" className="md:px-3 md:py-2.5">
        {record.syncStatus === "error" ? (
          <button
            type="button"
            onClick={() => setErrorOpen((v) => !v)}
            aria-expanded={errorOpen}
            aria-controls={errorId}
            className="inline-flex items-center gap-1"
          >
            <SyncBadge status="error" />
            <ChevronDown
              className={cn("size-3.5 text-danger transition-transform", errorOpen && "rotate-180")}
              aria-hidden
            />
            <span className="sr-only">展開錯誤說明</span>
          </button>
        ) : (
          <SyncBadge status={deleting ? "deleting" : record.syncStatus} key={record.syncStatus} />
        )}
      </span>
      <span
        role="cell"
        className="col-span-2 flex items-center justify-end gap-0.5 pt-1 md:col-span-1 md:px-2 md:pt-0"
      >
        <CopyButton
          value={digCommand(record)}
          label={`複製檢查 ${record.name} 的 dig 指令`}
          className="hidden md:inline-flex"
        />
        <button
          type="button"
          onClick={onEdit}
          disabled={disabled || struck || isTemp}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-30"
          aria-label={`編輯 ${record.name} ${record.type}`}
        >
          <Pencil className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled || struck || isTemp}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-danger-soft hover:text-danger disabled:opacity-30"
          aria-label={`刪除 ${record.name} ${record.type}`}
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </span>
      {record.syncStatus === "error" ? (
        <div
          id={errorId}
          role="cell"
          className="expand col-span-2 md:col-span-6"
          data-open={errorOpen}
        >
          <div className="mx-0 mb-3 flex flex-wrap items-center gap-3 rounded-md border border-danger bg-danger-soft px-3 py-2 font-sans text-sm md:mx-3">
            <span className="zone font-semibold text-danger">
              {record.syncError?.code ?? "ERROR"}
            </span>
            <span>{record.syncError?.message ?? "同步失敗"}</span>
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              onClick={onRetry}
              disabled={disabled}
            >
              <RotateCw aria-hidden />
              重試
            </Button>
          </div>
        </div>
      ) : null}
    </motion.div>
  );
}

function EditRow({
  record,
  subdomain,
  onCancel,
  onSaved,
  validationContext,
  allowedTypes,
  onConflictReload,
}: {
  record: DnsRecord;
  subdomain: Subdomain;
  onCancel: () => void;
  onSaved: (record: DnsRecord) => void;
  validationContext: ValidateContext;
  allowedTypes: readonly RecordType[];
  onConflictReload: () => void;
}) {
  const [draft, setDraft] = useState<RecordDraft>(() => draftFromRecord(record));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const id = useId();

  const save = async (version = record.version) => {
    const result = validateDraft(draft, validationContext);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const next = await api("replaceRecord", {
        params: { name: subdomain.name, recordId: record.id },
        body: result.input,
        ifMatch: version,
      });
      onSaved(next);
    } catch (error) {
      if (isApiError(error, "VERSION_CONFLICT")) {
        setConflict(true);
      } else {
        setErrors(fieldErrors(error));
        setMessage(errorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  };

  /** 覆蓋：先取得最新版本號，再用它重送（使用者明確選擇蓋掉別處的修改） */
  const overwrite = async () => {
    const latest = await api("listRecords", { params: { name: subdomain.name } });
    const current = latest.items.find((r) => r.id === record.id);
    if (!current) {
      setMessage("這筆紀錄已經被刪除了。");
      return;
    }
    setConflict(false);
    await save(current.version);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      save();
    }
  };

  return (
    <div
      role="row"
      className="border-b border-rule bg-magpie-soft/60 p-3 md:col-span-6"
      data-testid={`edit-${record.id}`}
    >
      <div role="cell" className="space-y-3 font-sans">
        <p className="zone text-xs text-ink-muted">
          編輯 {record.name} {record.type} · Esc 取消 · ⌘Enter 儲存
        </p>
        <RecordFields
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            setErrors({});
          }}
          errors={errors}
          idPrefix={`${id}-edit`}
          sub={subdomain.name}
          allowedTypes={allowedTypes}
          onKeyDown={onKeyDown}
          autoFocusField="name"
        />
        {conflict ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-md border border-amber bg-amber-soft p-3 text-sm"
          >
            <span>這筆紀錄已在別處被修改。</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onConflictReload();
                onCancel();
              }}
            >
              重新載入
            </Button>
            <Button size="sm" variant="danger" onClick={overwrite}>
              用我的版本覆蓋
            </Button>
          </div>
        ) : null}
        {message ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {message}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => save()} disabled={saving}>
            {saving ? "儲存中…" : "儲存"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        </div>
      </div>
    </div>
  );
}
