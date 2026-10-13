// biome-ignore-all lint/a11y/useSemanticElements: zone file 表格用 CSS subgrid 對齊並在手機改成卡片，<table> 做不到，因此用 ARIA table 角色
// biome-ignore-all lint/a11y/useFocusableInteractive: role="row"／"cell" 是表格結構，不是互動元件
"use client";

import type { DnsRecord, RecordInput, RecordList, RecordType, Subdomain } from "@dit/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Plus } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useSearchParams } from "next/navigation";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/app/copy-button.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogTrigger, SheetContent } from "@/components/ui/dialog.tsx";
import { api, idempotencyKey, isApiError } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage, fieldErrors } from "@/lib/errors.ts";
import { q } from "@/lib/queries.ts";
import { cnameHint, type FieldErrors, validateDraft } from "@/lib/record-validate.ts";
import { emptyDraft, type RecordDraft, zoneFile } from "@/lib/records.ts";
import { useSync } from "@/lib/sse.tsx";
import { RecordFields } from "./record-fields.tsx";
import { RecordRow } from "./record-row.tsx";
import { ZoneTree } from "./zone-tree.tsx";

const UNDO_MS = 5000;
const DEFAULT_TYPES: RecordType[] = ["A", "AAAA", "CNAME", "TXT", "MX"];

/**
 * DNS 編輯器（本產品的核心畫面，§4.3）：表格是 zone file 行，用 CSS subgrid 對齊欄位。
 * 新增是樂觀插入；編輯帶 If-Match；刪除先畫刪除線並給 5 秒 Undo，之後才真正送出 DELETE。
 */
export function RecordEditor({
  subdomain,
  initial,
  ownedSubdomains,
}: {
  subdomain: Subdomain;
  initial: RecordList;
  ownedSubdomains: string[];
}) {
  const name = subdomain.name;
  const queryClient = useQueryClient();
  const { mode } = useSync();
  const meta = useQuery(q.meta());
  const allowedTypes = meta.data?.allowedRecordTypes ?? DEFAULT_TYPES;
  const recordsKey = q.records(name).queryKey;
  const records = useQuery({
    ...q.records(name),
    initialData: initial,
    // SSE 不可用（P1 回 501）時，有 pending 紀錄就每 3 秒輪詢
    refetchInterval: (query) =>
      mode === "polling" &&
      query.state.data?.items.some((r) => r.syncStatus === "pending" || r.syncStatus === "deleting")
        ? 3000
        : false,
  });
  const items = records.data?.items ?? [];
  const usage = records.data?.usage ?? initial.usage;
  const active = subdomain.status === "active";

  const search = useSearchParams();
  const [draft, setDraft] = useState<RecordDraft>(() => prefill(search, allowedTypes));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ReadonlySet<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const deleteTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const tempSeq = useRef(0);
  // 樂觀插入的列換成伺服器的 id 後沿用原本的 React key，避免 AnimatePresence 把它當成「刪除＋新增」
  const stableKeys = useRef(new Map<string, string>());
  const formId = useId();
  // 指令面板的 add 會帶著 ?add= 導到這頁；已經在這頁時也要套用新的預填
  const addParam = search.toString();
  useEffect(() => {
    if (new URLSearchParams(addParam).get("add"))
      setDraft(prefill(new URLSearchParams(addParam), allowedTypes));
  }, [addParam, allowedTypes]);
  const autoFocusField = search.get("add")
    ? search.get("value")
      ? undefined
      : "target"
    : undefined;

  useEffect(() => {
    const timers = deleteTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  const setRecords = (fn: (list: RecordList) => RecordList) =>
    queryClient.setQueryData<RecordList>(recordsKey, (old) => (old ? fn(old) : old));

  const ctx = useMemo(
    () => ({ sub: name, root: "dev-in.tw", existing: items, ownedSubdomains, allowedTypes }),
    [name, items, ownedSubdomains, allowedTypes],
  );

  const create = useMutation({
    mutationFn: (vars: { body: RecordInput; tempId: string; key: string }) =>
      api("createRecord", { params: { name }, body: vars.body, idempotencyKey: vars.key }),
    onMutate: ({ body, tempId }) => {
      const now = new Date().toISOString();
      setRecords((list) => ({
        ...list,
        items: [
          ...list.items,
          {
            ...(body as DnsRecord),
            id: tempId,
            fqdn: body.name === "@" ? subdomain.fqdn : `${body.name}.${subdomain.fqdn}`,
            version: 1,
            syncStatus: "pending",
            syncError: null,
            createdAt: now,
            updatedAt: now,
          } as DnsRecord,
        ],
        usage: { ...list.usage, used: list.usage.used + 1 },
      }));
    },
    onSuccess: (record, { tempId }) => {
      stableKeys.current.set(record.id, tempId);
      setRecords((list) => ({
        ...list,
        items: list.items.map((r) => (r.id === tempId ? record : r)),
      }));
      setDraft((d) => ({ ...emptyDraft(d.type), name: d.name === "@" ? "@" : "" }));
      setErrors({});
      setFormError(null);
      setSheetOpen(false);
    },
    onError: (error, { tempId }) => {
      setRecords((list) => ({
        ...list,
        items: list.items.filter((r) => r.id !== tempId),
        usage: { ...list.usage, used: Math.max(0, list.usage.used - 1) },
      }));
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    },
  });

  const submitAdd = () => {
    setFormError(null);
    const result = validateDraft(draft, ctx);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    tempSeq.current += 1;
    create.mutate({ tempId: `temp-${tempSeq.current}`, body: result.input, key: idempotencyKey() });
  };

  const onAddKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      submitAdd();
    }
  };

  const scheduleDelete = (record: DnsRecord) => {
    setPendingDelete((prev) => new Set(prev).add(record.id));
    const undo = () => {
      clearTimeout(deleteTimers.current.get(record.id));
      deleteTimers.current.delete(record.id);
      setPendingDelete((prev) => {
        const next = new Set(prev);
        next.delete(record.id);
        return next;
      });
    };
    const label = `${record.name} ${record.type}`;
    toast(`已刪除 ${label}`, {
      description: "5 秒內可以復原",
      duration: UNDO_MS,
      action: { label: "復原", onClick: undo },
    });
    const timer = setTimeout(async () => {
      deleteTimers.current.delete(record.id);
      try {
        const deleted = await api("deleteRecord", {
          params: { name, recordId: record.id },
          ifMatch: record.version,
        });
        setRecords((list) => ({
          ...list,
          items: list.items.map((r) => (r.id === record.id ? deleted : r)),
          usage: { ...list.usage, used: Math.max(0, list.usage.used - 1) },
        }));
      } catch (error) {
        toast.error(`刪除 ${label} 失敗`, { description: errorMessage(error) });
      } finally {
        setPendingDelete((prev) => {
          const next = new Set(prev);
          next.delete(record.id);
          return next;
        });
      }
    }, UNDO_MS);
    deleteTimers.current.set(record.id, timer);
  };

  const touched = [draft.address, draft.target, draft.value, draft.exchange].some(
    (v) => v.trim() !== "",
  );
  const hint = touched ? cnameHint(draft, items) : null;
  const visible = items;
  const full = usage.used >= usage.limit;

  const addForm = (layout: "row" | "stack") => (
    <form
      id={`${formId}-${layout}`}
      onSubmit={(e) => {
        e.preventDefault();
        submitAdd();
      }}
      aria-label="新增紀錄"
      className="space-y-3"
    >
      <RecordFields
        draft={draft}
        onChange={(next) => {
          setDraft(next);
          if (Object.keys(errors).length) setErrors({});
        }}
        errors={errors}
        idPrefix={`${formId}-${layout}-add`}
        sub={name}
        allowedTypes={allowedTypes}
        layout={layout}
        onKeyDown={onAddKey}
        autoFocusField={layout === "row" ? autoFocusField : undefined}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={create.isPending || full || !active}>
          <Plus aria-hidden />
          新增紀錄
        </Button>
        <span className="zone hidden text-xs text-ink-muted md:inline">Enter 送出</span>
        {hint ? (
          <p className="flex items-center gap-1.5 text-sm text-amber">
            <Info className="size-4" aria-hidden />
            {hint}
          </p>
        ) : null}
        {formError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {formError}
          </p>
        ) : null}
      </div>
    </form>
  );

  return (
    <div className="grid gap-8 xl:grid-cols-[1fr_15rem]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="zone text-sm">
            <span className={cn("font-semibold", full && "text-danger")} data-testid="record-usage">
              {usage.used} / {usage.limit}
            </span>{" "}
            <span className="text-ink-muted">筆紀錄</span>
            <span className="ml-3 hidden text-ink-muted sm:inline">· CNAME 不能和其他紀錄同名</span>
          </p>
          <div className="flex items-center gap-1">
            <span className="zone text-xs text-ink-muted">複製成 zone file</span>
            <CopyButton value={zoneFile(name, items)} label="複製整份 zone file" />
          </div>
        </div>

        {!active ? (
          <p className="mt-4 rounded-md border border-amber bg-amber-soft p-3 text-sm">
            子網域目前不是啟用狀態，暫時不能新增或修改紀錄。
          </p>
        ) : null}

        <div
          role="table"
          aria-label={`${subdomain.fqdn} 的 DNS 紀錄`}
          aria-rowcount={visible.length + 1}
          className="zone mt-4 grid grid-cols-1 overflow-hidden rounded-md border border-rule bg-bg text-[0.92rem] shadow-[4px_4px_0_var(--shadow)] md:grid-cols-[minmax(7rem,1.1fr)_4.5rem_4.5rem_minmax(10rem,2fr)_8.5rem_7.5rem]"
        >
          <div
            role="row"
            className="hidden border-b border-rule bg-surface text-xs font-semibold tracking-wider text-ink-muted md:col-span-6 md:grid md:grid-cols-subgrid"
          >
            {["NAME", "TTL", "TYPE", "VALUE", "STATUS", ""].map((h, i) => (
              <span key={h || i} role="columnheader" className="px-3 py-2.5">
                {h || <span className="sr-only">操作</span>}
              </span>
            ))}
          </div>

          {active ? (
            <div
              role="row"
              className="hidden border-b border-rule bg-[color-mix(in_oklch,var(--magpie-soft)_50%,var(--bg))] p-3 md:col-span-6 md:block"
            >
              <div role="cell" className="font-sans">
                {addForm("row")}
              </div>
            </div>
          ) : null}

          <AnimatePresence initial={false}>
            {visible.map((record) => (
              <RecordRow
                key={stableKeys.current.get(record.id) ?? record.id}
                record={record}
                subdomain={subdomain}
                editing={editingId === record.id}
                deleting={pendingDelete.has(record.id)}
                highlighted={hovered === record.name}
                onHover={setHovered}
                onEdit={() => setEditingId(record.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaved={(next) => {
                  setRecords((list) => ({
                    ...list,
                    items: list.items.map((r) => (r.id === next.id ? next : r)),
                  }));
                  setEditingId(null);
                }}
                onDelete={() => scheduleDelete(record)}
                onRetry={async () => {
                  try {
                    const next = await api("retryRecordSync", {
                      params: { name, recordId: record.id },
                    });
                    setRecords((list) => ({
                      ...list,
                      items: list.items.map((r) => (r.id === next.id ? next : r)),
                    }));
                  } catch (error) {
                    toast.error("重試失敗", { description: errorMessage(error) });
                  }
                }}
                validationContext={{ ...ctx, existing: items.filter((r) => r.id !== record.id) }}
                allowedTypes={allowedTypes}
                disabled={!active}
                onConflictReload={() => queryClient.invalidateQueries({ queryKey: recordsKey })}
              />
            ))}
          </AnimatePresence>

          {visible.length === 0 ? (
            <div role="row" className="md:col-span-6">
              <p role="cell" className="px-4 py-10 text-center font-sans text-ink-muted">
                ;; 還沒有任何紀錄。新增一筆，或到「總覽」一鍵套用 GitHub Pages、Vercel 等設定。
              </p>
            </div>
          ) : null}
        </div>

        {/* 手機：新增列改成底部 sheet */}
        {active ? (
          <div className="mt-4 md:hidden">
            <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
              <DialogTrigger asChild>
                <Button className="w-full" disabled={full}>
                  <Plus aria-hidden />
                  新增紀錄
                </Button>
              </DialogTrigger>
              <SheetContent title="新增紀錄">{addForm("stack")}</SheetContent>
            </Dialog>
          </div>
        ) : null}
      </div>

      <aside className="hidden xl:block" aria-label="zone tree">
        <ZoneTree sub={name} records={items} hovered={hovered} onHover={setHovered} />
      </aside>
    </div>
  );
}

function prefill(search: URLSearchParams, allowed: readonly RecordType[]): RecordDraft {
  const type = search.get("add")?.toUpperCase() as RecordType | undefined;
  if (!type || !allowed.includes(type)) return emptyDraft("CNAME");
  const draft = { ...emptyDraft(type), name: search.get("name") || "@" };
  const value = search.get("value") ?? "";
  const ttl = search.get("ttl");
  if (ttl) draft.ttl = ttl;
  if (type === "A" || type === "AAAA") draft.address = value;
  else if (type === "CNAME") draft.target = value;
  else if (type === "TXT") draft.value = value;
  else if (type === "MX") {
    const [priority, exchange] = value.includes(" ") ? value.split(/\s+/) : ["10", value];
    draft.priority = priority ?? "10";
    draft.exchange = exchange ?? "";
  }
  return draft;
}

export function isConflict(error: unknown): boolean {
  return isApiError(error, "VERSION_CONFLICT");
}
