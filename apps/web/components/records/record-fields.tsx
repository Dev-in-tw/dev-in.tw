"use client";

import type { RecordType } from "@dit/contract";
import type { KeyboardEvent } from "react";
import { Input, Select } from "@/components/ui/field.tsx";
import { cn } from "@/lib/cn.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";
import type { FieldErrors } from "@/lib/record-validate.ts";
import { FIELD_META, FIELDS, fqdnOf, type RecordDraft, TTL_OPTIONS } from "@/lib/records.ts";

/**
 * 紀錄欄位：依類型切換（MX 多 priority；SRV 多 priority、weight、port、target；CAA 多 flags、tag、value）。
 * 新增列、行內編輯與手機 sheet 共用。網域相關欄位一律 autocapitalize=none、spellcheck=false。
 */
export function RecordFields({
  draft,
  onChange,
  errors,
  idPrefix,
  sub,
  allowedTypes,
  layout = "row",
  onKeyDown,
  autoFocusField,
}: {
  draft: RecordDraft;
  onChange: (next: RecordDraft) => void;
  errors: FieldErrors;
  idPrefix: string;
  sub: string;
  allowedTypes: readonly RecordType[];
  layout?: "row" | "stack";
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  autoFocusField?: keyof RecordDraft;
}) {
  const set = (key: keyof RecordDraft, value: string) => onChange({ ...draft, [key]: value });
  const id = (key: string) => `${idPrefix}-${key}`;
  const err = (key: keyof FieldErrors) => errors[key];
  const describedBy = (key: keyof FieldErrors, extra?: string) =>
    [err(key) ? id(`${key}-error`) : null, extra].filter(Boolean).join(" ") || undefined;
  const fields = FIELDS[draft.type];
  const stack = layout === "stack";

  const fieldClass = "zone h-9 text-[0.92rem]";
  const labelClass = cn("text-xs font-medium text-ink-muted", !stack && "sr-only md:not-sr-only");

  return (
    <fieldset
      className={cn(
        "m-0 grid min-w-0 gap-3 border-0 p-0",
        stack
          ? "grid-cols-1"
          : "md:grid-cols-[7.5rem_minmax(9rem,1fr)_6rem_minmax(12rem,2fr)] md:items-start",
      )}
      aria-label="紀錄欄位"
      onKeyDown={onKeyDown}
    >
      <div className="space-y-1">
        <label htmlFor={id("type")} className={labelClass}>
          類型
        </label>
        <Select
          id={id("type")}
          value={draft.type}
          onChange={(e) => onChange({ ...draft, type: e.target.value as RecordType })}
          className={fieldClass}
          aria-invalid={Boolean(err("type"))}
          aria-describedby={describedBy("type")}
        >
          {allowedTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
        <ErrorText id={id("type-error")} message={err("type")} />
      </div>

      <div className="space-y-1">
        <label htmlFor={id("name")} className={labelClass}>
          名稱
        </label>
        <Input
          id={id("name")}
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="@"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          className={fieldClass}
          aria-invalid={Boolean(err("name"))}
          aria-describedby={describedBy("name", id("fqdn"))}
          autoFocus={autoFocusField === "name"}
        />
        <p
          id={id("fqdn")}
          className="zone truncate text-[0.72rem] text-ink-muted"
          title={fqdnOf(draft.name, sub)}
        >
          → {fqdnOf(draft.name, sub)}
        </p>
        <ErrorText id={id("name-error")} message={err("name")} />
      </div>

      <div className="space-y-1">
        <label htmlFor={id("ttl")} className={labelClass}>
          TTL
        </label>
        <Select
          id={id("ttl")}
          value={draft.ttl}
          onChange={(e) => set("ttl", e.target.value)}
          className={fieldClass}
        >
          {TTL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {TTL_OPTIONS.some((o) => o.value === draft.ttl) ? null : (
            <option value={draft.ttl}>{draft.ttl}s</option>
          )}
        </Select>
      </div>

      <div
        className={cn(
          "grid gap-3",
          fields.length > 1 && !stack && "md:grid-cols-[repeat(var(--n),minmax(0,1fr))]",
        )}
        style={{ ["--n" as string]: fields.length }}
      >
        {fields.map((key) => {
          const meta = FIELD_META[key];
          if (!meta) return null;
          const isNumber = meta.inputMode === "numeric";
          return (
            <div
              key={key}
              className={cn(
                "space-y-1",
                (key === "target" || key === "value" || key === "exchange") &&
                  fields.length > 1 &&
                  !stack &&
                  "md:col-span-1",
              )}
            >
              <label htmlFor={id(key)} className={labelClass}>
                {meta.label}
                <span className="sr-only">（{t.recordType[draft.type]}）</span>
              </label>
              {key === "tag" ? (
                <Select
                  id={id(key)}
                  value={draft.tag}
                  onChange={(e) => set("tag", e.target.value)}
                  className={fieldClass}
                >
                  <option value="issue">issue</option>
                  <option value="issuewild">issuewild</option>
                  <option value="iodef">iodef</option>
                </Select>
              ) : (
                <Input
                  id={id(key)}
                  value={draft[key]}
                  onChange={(e) => set(key, e.target.value)}
                  placeholder={meta.placeholder(draft.type)}
                  inputMode={meta.inputMode}
                  type={isNumber ? "text" : "text"}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  className={fieldClass}
                  aria-invalid={Boolean(err(key))}
                  aria-describedby={describedBy(key)}
                  autoFocus={autoFocusField === key}
                />
              )}
              <ErrorText id={id(`${key}-error`)} message={err(key)} />
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function ErrorText({ id, message }: { id: string; message?: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-[0.78rem] font-medium text-danger" role="alert">
      {message}
    </p>
  );
}
