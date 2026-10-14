export { findConflicts, MAX_TXT_PER_NAME } from "./conflicts.ts";
export {
  canonicalIPv6,
  DENIED_IPV4_RANGES,
  DENIED_IPV6_RANGES,
  describeNonPublicIPv4,
  describeNonPublicIPv6,
  formatIPv6,
  isIPAddress,
  isPublicIPv4,
  isPublicIPv6,
  parseIPv4,
  parseIPv6,
} from "./ip-rules.ts";
export {
  checkLabelSyntax,
  confusableWith,
  FUZZY_BRAND_MIN_LENGTH,
  isPremiumLength,
  leetSkeleton,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  normalizeLabel,
  withinOneEdit,
} from "./name-rules.ts";
export {
  PRESET_TTL,
  PRESETS,
  type PresetContext,
  type PresetPlanResult,
  planPreset,
  prefixedName,
} from "./presets.ts";
export {
  type DnsProviderKind,
  LAZCO_RESERVED_LABEL,
  providerViolations,
} from "./provider-rules.ts";
export { describeRecord, isSameRecord, recordContent, recordDataEquals } from "./record-data.ts";
export {
  CAA_TAGS,
  isSpecialUseHostname,
  isValidTtl,
  MAX_FQDN_LENGTH,
  type RecordContext,
  SPECIAL_USE_SUFFIXES,
  SRV_PROTOCOLS,
  subdomainOf,
  TXT_MAX_LENGTH,
  toFqdn,
  validateRecord,
} from "./record-rules.ts";
export { BRAND_NAMES, RESERVED_SEED, type ReservedSeed } from "./reserved-seed.ts";
export { OK, type Verdict, type Violation, verdictOf } from "./types.ts";
export { TXT_CHUNK, toZoneFile, toZoneLine, txtChunks, zoneData } from "./zone-line.ts";
