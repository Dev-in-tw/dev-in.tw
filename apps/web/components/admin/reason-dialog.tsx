"use client";

import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent } from "@/components/ui/dialog.tsx";
import { FieldError, Label, Textarea } from "@/components/ui/field.tsx";

/** 所有危險操作都要填理由，送出後寫入稽核（§4.3 Admin） */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  required = true,
  danger = true,
  pending,
  error,
  onSubmit,
  extra,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  required?: boolean;
  danger?: boolean;
  pending?: boolean;
  error?: string | null;
  onSubmit: (reason: string) => void;
  extra?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setReason("");
        onOpenChange(v);
      }}
    >
      <DialogContent title={title} description={description}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(reason.trim());
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={id}>理由{required ? "" : "（選填）"}</Label>
            <Textarea
              id={id}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              required={required}
            />
          </div>
          {extra}
          <FieldError>{error}</FieldError>
          <Button
            type="submit"
            variant={danger ? "danger-solid" : "primary"}
            className="w-full"
            disabled={pending || (required && !reason.trim())}
          >
            {confirmLabel}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
