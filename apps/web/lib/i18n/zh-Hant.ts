import type {
  AvailabilityStatus,
  ErrorCode,
  RecordType,
  ReportCategory,
  SubdomainStatus,
  SyncStatus,
  TransferStatus,
} from "@dit/contract";

/**
 * 繁體中文字典。現在只有 zh-Hant，結構預留給 P2 的英文介面：
 * 共用的狀態、錯誤碼與動作文案集中在這裡，頁面本文則寫在各自的元件裡。
 */
export const zhHant = {
  syncStatus: {
    pending: "PENDING",
    synced: "SYNCED",
    error: "ERROR",
    deleting: "DELETING",
  } satisfies Record<SyncStatus, string>,
  syncStatusSpoken: {
    pending: "同步中",
    synced: "已同步",
    error: "同步失敗",
    deleting: "刪除中",
  } satisfies Record<SyncStatus, string>,
  subdomainStatus: {
    active: "ACTIVE",
    pending_review: "REVIEW",
    suspended: "SUSPENDED",
    releasing: "RELEASING",
  } satisfies Record<SubdomainStatus, string>,
  subdomainStatusSpoken: {
    active: "啟用中",
    pending_review: "審核中",
    suspended: "已停權",
    releasing: "釋出中",
  } satisfies Record<SubdomainStatus, string>,
  transferStatus: {
    pending: "等待對方接受",
    accepted: "已接受",
    declined: "已拒絕",
    cancelled: "已取消",
    expired: "已過期",
  } satisfies Record<TransferStatus, string>,
  availability: {
    available: { code: "NXDOMAIN", text: "可以申請" },
    review: { code: "NXDOMAIN", text: "可以申請，但需要人工審核" },
    taken: { code: "NOERROR", text: "已被使用" },
    reserved: { code: "REFUSED", text: "保留名稱" },
    invalid: { code: "FORMERR", text: "名稱格式不正確" },
    cooldown: { code: "SERVFAIL", text: "冷卻中" },
    capacity_full: { code: "SERVFAIL", text: "名額已滿" },
  } satisfies Record<AvailabilityStatus, { code: string; text: string }>,
  reviewReason: (reason: string): string => {
    if (reason === "account_too_new") return "GitHub 帳號建立未滿 30 天";
    if (reason === "review_all") return "目前所有申請都需要審核";
    if (reason.startsWith("confusable:")) return `和品牌「${reason.slice(11)}」相似`;
    return reason;
  },
  recordType: {
    A: "IPv4 位址",
    AAAA: "IPv6 位址",
    CNAME: "別名（指向另一個主機名）",
    TXT: "文字（驗證、SPF 等）",
    MX: "郵件伺服器",
    SRV: "服務位置",
    CAA: "憑證機構授權",
  } satisfies Record<RecordType, string>,
  reportCategory: {
    phishing: "釣魚或詐騙",
    malware: "惡意程式",
    spam: "垃圾內容",
    illegal: "違法內容",
    impersonation: "冒用身分或品牌",
    other: "其他",
  } satisfies Record<ReportCategory, string>,
  errors: {
    VALIDATION_FAILED: "有欄位格式不正確，請檢查後再送出。",
    NOT_FOUND: "找不到這個項目，可能已經被刪除。",
    UNAUTHENTICATED: "登入已過期，請重新登入。",
    FORBIDDEN: "你沒有權限做這件事。",
    CSRF_REJECTED: "請求來源不正確，請重新整理頁面後再試。",
    RATE_LIMITED: "操作太頻繁了，休息一下再試。",
    VERSION_CONFLICT: "這筆紀錄已在別處被修改。",
    IDEMPOTENCY_KEY_REUSED: "重複送出的內容不一致，請重新整理後再試。",
    NOT_IMPLEMENTED: "這個功能即將推出。",
    INTERNAL: "伺服器出了點狀況，我們已經記錄下來。",
    ACCOUNT_SUSPENDED: "你的帳號已被停權。",
    REGISTRATION_CLOSED: "目前暫停開放申請。",
    TURNSTILE_FAILED: "人機驗證失敗，請再試一次。",
    CONFIRMATION_MISMATCH: "確認文字不符。",
    NAME_INVALID: "名稱格式不正確。",
    NAME_RESERVED: "這是保留名稱。",
    NAME_TAKEN: "這個名稱剛剛被別人申請走了。",
    NAME_COOLDOWN: "這個名稱還在冷卻期。",
    SUBDOMAIN_QUOTA_EXCEEDED: "你的子網域數量已達上限。",
    ZONE_CAPACITY_EXHAUSTED: "整個 zone 的容量已滿，暫時無法新增。",
    SUBDOMAIN_NOT_ACTIVE: "子網域目前不是啟用狀態。",
    RECORD_QUOTA_EXCEEDED: "這個子網域的紀錄數量已達上限。",
    RECORD_CONFLICT: "和現有的紀錄衝突。",
    RECORD_DUPLICATE: "已經有一筆一模一樣的紀錄。",
    RECORD_TYPE_NOT_ALLOWED: "目前不開放這個紀錄類型。",
    RECORD_TARGET_NOT_ALLOWED: "不允許指向這個目標。",
    IP_NOT_PUBLIC: "必須是公網位址，私有位址外部無法連線。",
    PRESET_PARAMS_INVALID: "一鍵設定的參數不正確。",
    TRANSFER_RECIPIENT_NOT_FOUND: "找不到這位使用者，對方需要先登入過 Dev-in.tw。",
    TRANSFER_RECIPIENT_QUOTA: "對方的子網域數量已達上限。",
    TRANSFER_INVALID_STATE: "這筆轉移已經結束了。",
    TRANSFER_ALREADY_PENDING: "已經有一筆進行中的轉移。",
    UPSTREAM_DNS_ERROR: "DNS 服務暫時無法回應，稍後會自動重試。",
    UPSTREAM_GITHUB_ERROR: "GitHub 暫時無法回應，請稍後再試。",
  } satisfies Record<ErrorCode, string>,
};

export type Dictionary = typeof zhHant;
export const t: Dictionary = zhHant;
