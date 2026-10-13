"use client";

import type { ReservedCategory, ReservedName } from "@dit/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.tsx";
import { FieldError, Input, Label, Select } from "@/components/ui/field.tsx";
import { api } from "@/lib/api/client.ts";
import { errorMessage } from "@/lib/errors.ts";
import { formatDate } from "@/lib/time.ts";
import { Chip, DataTable, ListState, useAdminList } from "./common.tsx";

const CATEGORIES: { value: ReservedCategory; label: string }[] = [
  { value: "system", label: "系統" },
  { value: "brand", label: "品牌" },
  { value: "offensive", label: "冒犯" },
  { value: "premium", label: "短名稱" },
  { value: "zone", label: "zone 既有" },
];

export function AdminReserved() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ReservedCategory | "">("");
  const q = useDeferredValue(search.trim().toLowerCase());
  const list = useAdminList("adminListReserved", {
    ...(q ? { q } : {}),
    ...(category ? { category } : {}),
  });
  const items = (list.data?.pages.flatMap((p) => p.items) ?? []) as ReservedName[];
  const queryClient = useQueryClient();
  const id = useId();
  const [name, setName] = useState("");
  const [newCategory, setNewCategory] = useState<ReservedCategory>("brand");
  const [note, setNote] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["adminListReserved"] });
  const add = useMutation({
    mutationFn: () =>
      api("adminAddReserved", {
        body: { name: name.trim().toLowerCase(), category: newCategory, ...(note ? { note } : {}) },
      }),
    onSuccess: (r) => {
      toast.success(`已保留 ${r.name}`);
      setName("");
      setNote("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (n: string) => api("adminRemoveReserved", { params: { name: n } }),
    onSuccess: () => {
      toast("已移除");
      refresh();
    },
    onError: (e) => toast.error("移除失敗", { description: errorMessage(e) }),
  });

  return (
    <div>
      <h1 className="text-step-3 font-semibold tracking-tight">保留字</h1>
      <form
        className="mt-5 grid gap-3 rounded-md border border-rule bg-surface p-4 sm:grid-cols-[1fr_9rem_1.5fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={`${id}-name`}>名稱</Label>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[a-z0-9-]{1,63}"
            required
            className="zone"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-cat`}>類別</Label>
          <Select
            id={`${id}-cat`}
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as ReservedCategory)}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-note`}>備註</Label>
          <Input
            id={`${id}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
          />
        </div>
        <Button type="submit" disabled={add.isPending}>
          新增
        </Button>
        <div className="sm:col-span-4">
          <FieldError>{add.isError ? errorMessage(add.error) : null}</FieldError>
        </div>
      </form>
      <div className="mt-5 flex flex-wrap gap-3">
        <label htmlFor="reserved-search" className="sr-only">
          搜尋保留字
        </label>
        <Input
          id="reserved-search"
          data-search
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜尋"
          className="zone max-w-xs"
        />
        <label htmlFor="reserved-cat" className="sr-only">
          類別
        </label>
        <Select
          id="reserved-cat"
          value={category}
          onChange={(e) => setCategory(e.target.value as ReservedCategory | "")}
          className="w-36"
        >
          <option value="">所有類別</option>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="mt-5">
        <ListState query={list} empty={items.length === 0}>
          <DataTable label="保留字清單" head={["名稱", "類別", "備註", "建立者", "建立", ""]}>
            {items.map((r) => (
              <tr key={r.name} className="hover:bg-surface">
                <td className="zone px-3 py-2.5 font-medium">{r.name}</td>
                <td className="px-3 py-2.5">
                  <Chip
                    tone={
                      r.category === "brand"
                        ? "amber"
                        : r.category === "offensive"
                          ? "danger"
                          : "muted"
                    }
                  >
                    {CATEGORIES.find((c) => c.value === r.category)?.label ?? r.category}
                  </Chip>
                </td>
                <td className="px-3 py-2.5 text-ink-muted">{r.note ?? "—"}</td>
                <td className="zone px-3 py-2.5 text-ink-muted">
                  {r.createdBy ? `@${r.createdBy.githubLogin}` : "種子"}
                </td>
                <td className="zone px-3 py-2.5 text-ink-muted">{formatDate(r.createdAt)}</td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={() => remove.mutate(r.name)}
                    className="inline-flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-danger-soft hover:text-danger"
                    aria-label={`移除保留字 ${r.name}`}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </td>
              </tr>
            ))}
          </DataTable>
        </ListState>
      </div>
    </div>
  );
}
