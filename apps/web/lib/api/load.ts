import "server-only";
import type { Subdomain } from "@dit/contract";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ContractApiError, getServerApi } from "./server.ts";

/** 取子網域；別人的或不存在一律 404（後端也是回 404，不透露存在與否） */
export const loadSubdomain = cache(async (name: string): Promise<Subdomain> => {
  try {
    return await getServerApi()("getSubdomain", { params: { name } });
  } catch (error) {
    if (
      error instanceof ContractApiError &&
      (error.code === "NOT_FOUND" || error.code === "VALIDATION_FAILED")
    ) {
      notFound();
    }
    throw error;
  }
});
