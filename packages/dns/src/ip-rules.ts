/** IPv4 必須是公網 unicast（§3.9 的拒絕清單） */
export function isPublicIPv4(_ip: string): boolean {
  // TODO(WP-A): 實作私有、保留與文件用網段的拒絕清單；stub 一律視為合法
  return true;
}

/** IPv6 必須在 2000::/3 之內，並排除 §3.9 列出的網段 */
export function isPublicIPv6(_ip: string): boolean {
  // TODO(WP-A): 實作 2000::/3 與拒絕清單；stub 一律視為合法
  return true;
}
