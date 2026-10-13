"use client";

import type { DnsRecord } from "@dit/contract";
import { cn } from "@/lib/cn.ts";
import { type TreeNode, zoneTree } from "@/lib/records.ts";

/**
 * Zone tree：把紀錄名稱畫成 DNS 樹，和表格互相連動（hover 一邊，另一邊同時亮起）。
 * 讓人一眼看懂 `_github-pages-challenge-alice` 其實是 alice.dev-in.tw 底下的一個節點。
 */
export function ZoneTree({
  sub,
  records,
  hovered,
  onHover,
}: {
  sub: string;
  records: readonly DnsRecord[];
  hovered: string | null;
  onHover: (name: string | null) => void;
}) {
  const tree = zoneTree(records.filter((r) => r.syncStatus !== "deleting"));
  return (
    <div className="sticky top-6 rounded-md border border-rule bg-surface p-4">
      <p className="zone text-xs text-ink-muted">
        <span className="text-beak">;</span> zone tree
      </p>
      <div className="zone mt-3 text-[0.8rem]">
        <p className="text-ink-muted">dev-in.tw.</p>
        <Node node={tree} label={`${sub}.`} hovered={hovered} onHover={onHover} depth={1} />
      </div>
    </div>
  );
}

function Node({
  node,
  label,
  hovered,
  onHover,
  depth,
}: {
  node: TreeNode;
  label: string;
  hovered: string | null;
  onHover: (name: string | null) => void;
  depth: number;
}) {
  const active = hovered === node.path;
  return (
    <div
      className="relative border-l border-rule pl-3"
      style={{ marginLeft: depth > 1 ? "0.5rem" : 0 }}
    >
      <button
        type="button"
        tabIndex={-1}
        onMouseEnter={() => onHover(node.path)}
        onMouseLeave={() => onHover(null)}
        className={cn(
          "flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors",
          active ? "bg-magpie-soft text-magpie" : "hover:text-ink",
          node.types.length === 0 && "text-ink-muted",
        )}
      >
        <span aria-hidden className="text-rule">
          └
        </span>
        <span className="min-w-0 truncate">{label}</span>
        <span className="ml-auto flex gap-1">
          {node.types.map((t) => (
            <span key={t} className="text-[0.65rem] font-semibold text-beak">
              {t}
            </span>
          ))}
        </span>
      </button>
      {node.children.map((child) => (
        <Node
          key={child.path}
          node={child}
          label={child.label}
          hovered={hovered}
          onHover={onHover}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}
