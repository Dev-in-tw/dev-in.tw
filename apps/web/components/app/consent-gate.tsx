"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileCheck2, LogOut } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent } from "@/components/ui/dialog.tsx";
import { FieldError } from "@/components/ui/field.tsx";
import { api } from "@/lib/api/client.ts";
import { errorMessage } from "@/lib/errors.ts";
import { CURRENT_LEGAL_VERSIONS, LEGAL_DOCS } from "@/lib/legal.ts";
import { useMe } from "@/lib/me.tsx";
import { logout } from "./nav.tsx";

/**
 * 服務條款或隱私權政策改版後（`Me.consentRequired`），在控制台的任何頁面先請使用者重新同意。
 * 不能用 Esc 或點背景關掉：只能同意，或登出。同意的版本與時間由後端記錄（POST /me/consent）。
 */
export function ConsentGate() {
  const me = useMe();
  const router = useRouter();
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: () => api("acceptLegal", { body: CURRENT_LEGAL_VERSIONS }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["getMe"] });
      router.refresh();
    },
  });
  if (!me.consentRequired) return null;
  const firstTime = !me.consent;

  return (
    <Dialog open>
      <DialogContent
        hideClose
        title={firstTime ? "請先閱讀並同意服務條款" : "服務條款與隱私權政策已更新"}
        description={
          firstTime
            ? "繼續使用控制台前，請確認你同意下列文件。"
            : `你上次同意的是服務條款 v${me.consent?.termsVersion}、隱私權政策 v${me.consent?.privacyVersion}。`
        }
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        data-testid="consent-gate"
      >
        <ul className="space-y-2 text-sm">
          {(["terms", "privacy", "aup"] as const).map((slug) => {
            const doc = LEGAL_DOCS[slug];
            return (
              <li key={slug} className="flex items-center gap-2">
                <FileCheck2 className="size-4 text-signal" aria-hidden />
                <Link href={`/${doc.slug}`} className="link" target="_blank">
                  {doc.title}
                </Link>
                <span className="zone text-xs text-ink-muted">
                  v{doc.version} · {doc.effective} 生效
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-sm text-ink-muted">
          修訂內容寫在每份文件最後的「修訂紀錄」。不同意的話，可以登出後在設定頁下載你的資料或刪除帳號。
        </p>
        <FieldError>{accept.isError ? errorMessage(accept.error) : null}</FieldError>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => logout(router)}>
            <LogOut aria-hidden />
            登出
          </Button>
          <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
            我已閱讀並同意
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
