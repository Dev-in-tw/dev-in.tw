import type { AuditEvent } from "@dit/contract";
import { cn } from "@/lib/cn.ts";
import { formatDateTime } from "@/lib/time.ts";

const ACTIONS: Record<string, string> = {
  "auth.login": "登入",
  "auth.logout": "登出",
  "session.revoke": "登出了一個裝置",
  "user.delete": "刪除帳號",
  "subdomain.create": "申請子網域",
  "subdomain.approve": "子網域審核通過",
  "subdomain.reject": "子網域審核未通過",
  "subdomain.update": "更新子網域設定",
  "subdomain.release": "釋出子網域",
  "subdomain.suspend": "子網域被停權",
  "subdomain.unsuspend": "子網域解除停權",
  "record.create": "新增紀錄",
  "record.replace": "修改紀錄",
  "record.delete": "刪除紀錄",
  "record.sync_failed": "紀錄同步失敗",
  "record.drift_corrected": "修正了漂移的紀錄",
  "record.dangling_suspected": "CNAME 指向的名稱已不存在，可能被他人接管",
  "preset.apply": "套用一鍵設定",
  "transfer.create": "發起轉移",
  "transfer.accept": "接受轉移",
  "transfer.decline": "拒絕轉移",
  "transfer.cancel": "取消轉移",
  "transfer.expire": "轉移過期",
  "report.create": "收到檢舉",
  "report.resolve": "處理檢舉",
  "user.suspend": "停權使用者",
  "user.unsuspend": "解除使用者停權",
  "user.quota_change": "調整配額",
  "user.update": "更新使用者",
  "reserved.add": "新增保留字",
  "reserved.remove": "移除保留字",
  "zone.reconcile": "觸發對帳",
  "settings.update": "更新系統設定",
};

export function actionLabel(action: string): string {
  return ACTIONS[action] ?? action;
}

/** 稽核時間軸：zone file 註解風格的一行一事件 */
export function ActivityList({ items, className }: { items: AuditEvent[]; className?: string }) {
  if (items.length === 0) {
    return <p className={cn("text-sm text-ink-muted", className)}>還沒有任何活動。</p>;
  }
  return (
    <ol className={cn("relative space-y-0 border-l border-rule pl-5", className)}>
      {items.map((e) => (
        <li key={e.id} className="relative py-2.5">
          <span
            aria-hidden
            className={cn(
              "absolute top-4 -left-[1.6rem] size-2.5 rounded-full border-2 border-bg",
              e.action.includes("fail") ||
                e.action.includes("suspend") ||
                e.action.includes("dangling")
                ? "bg-danger"
                : e.actorType === "system"
                  ? "bg-field"
                  : "bg-magpie",
            )}
          />
          <p className="text-sm">
            <span className="font-medium">{actionLabel(e.action)}</span>
            <span className="zone ml-2 text-ink-muted">{e.target.label}</span>
          </p>
          <p className="zone mt-0.5 text-xs text-ink-muted">
            <time dateTime={e.createdAt}>{formatDateTime(e.createdAt)}</time>
            {" · "}
            {e.actor ? `@${e.actor.githubLogin}` : "系統"}
          </p>
        </li>
      ))}
    </ol>
  );
}
