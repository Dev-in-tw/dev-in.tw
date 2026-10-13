import { readFile } from "node:fs/promises";
import { RESERVED_SEED } from "@dit/dns";
import type { Db } from "./client.ts";
import { reservedNames } from "./schema.ts";

/**
 * 保留字種子（PLAN 附錄 A）。已存在的名稱不覆寫（管理員可能改過類別或備註）。
 * offensive 清單不進公開 repo：設定 RESERVED_PRIVATE_SEED_FILE（每行一個名稱，# 開頭為註解）
 * 指向機密掛載的檔案時一併匯入。
 */
export async function seedReservedNames(db: Db, privateSeedFile?: string): Promise<number> {
  const rows: {
    name: string;
    category: (typeof RESERVED_SEED)[number]["category"];
    note: string | null;
  }[] = RESERVED_SEED.map((r) => ({ name: r.name, category: r.category, note: r.note ?? null }));
  if (privateSeedFile) {
    const text = await readFile(privateSeedFile, "utf8");
    for (const line of text.split("\n")) {
      const name = line.trim().toLowerCase();
      if (name && !name.startsWith("#") && /^[a-z0-9-]{1,63}$/.test(name)) {
        rows.push({ name, category: "offensive", note: null });
      }
    }
  }
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const result = await db
      .insert(reservedNames)
      .values(rows.slice(i, i + 200))
      .onConflictDoNothing()
      .returning({ name: reservedNames.name });
    inserted += result.length;
  }
  return inserted;
}
