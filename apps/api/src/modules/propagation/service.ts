import type { Propagation, RecordType } from "@dit/contract";
import { presentAnswer, RESOLVERS } from "../../adapters/doh/client.ts";
import type { Deps } from "../../context.ts";
import type { UserRow } from "../../db/schema.ts";
import { TtlCache } from "../../lib/ttl-cache.ts";
import { fqdnOf } from "../../sync/mapper.ts";
import { liveRecords } from "../records/service.ts";
import { loadOwnedSubdomain } from "../subdomains/service.ts";

type ResolverRows = Propagation["resolvers"];
const cache = new TtlCache<{ resolvers: ResolverRows; checkedAt: string }>(15_000, 2000);

/** 傳播檢查（P1）：後端以 DoH 向四個 resolver 查詢，結果快取 15 秒 */
export async function getPropagation(
  deps: Deps,
  user: UserRow,
  name: string,
  query: { recordName: string; type: RecordType },
): Promise<Propagation> {
  const sub = await loadOwnedSubdomain(deps.db, user.id, name);
  const recordName = query.recordName.toLowerCase();
  const fqdn = fqdnOf(recordName, sub.name, deps.config.ROOT_DOMAIN);
  const expected = (await liveRecords(deps.db, sub.id))
    .filter((r) => r.name === recordName && r.type === query.type)
    .map((r) => presentAnswer(r.type, r.data));

  const key = `${fqdn}|${query.type}`;
  let hit = cache.get(key);
  if (!hit) {
    const resolvers = await Promise.all(
      RESOLVERS.map(async (resolver) => {
        const result = await deps.doh.query(resolver.id, fqdn, query.type);
        return {
          id: resolver.id,
          label: resolver.label,
          answers: result.answers,
          latencyMs: result.latencyMs,
          error: result.error,
        };
      }),
    );
    hit = {
      resolvers: resolvers.map((r) => ({ ...r, matches: false })),
      checkedAt: deps.clock.now().toISOString(),
    };
    cache.set(key, hit);
  }
  const want = new Set(expected.map((e) => e.toLowerCase()));
  return {
    fqdn,
    type: query.type,
    expected,
    resolvers: hit.resolvers.map((r) => {
      const got = new Set(r.answers.map((a) => a.toLowerCase()));
      const matches =
        r.error === null &&
        (want.size === 0
          ? got.size === 0
          : [...want].every((w) => got.has(w)) && got.size === want.size);
      return { ...r, matches };
    }),
    checkedAt: hit.checkedAt,
  };
}
