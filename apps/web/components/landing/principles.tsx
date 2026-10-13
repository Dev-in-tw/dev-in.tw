import { Ban, Cloud, Fingerprint, Gauge, Scale, ShieldCheck } from "lucide-react";

const ITEMS = [
  {
    icon: Fingerprint,
    title: "不收個資",
    body: "只用 GitHub 身分與主要 email。不要身分證、地址、電話或生日。",
  },
  {
    icon: Gauge,
    title: "每人 2 個名字",
    body: "每個子網域最多 10 筆紀錄。名額有限，留給真的會用的人。",
  },
  { icon: Cloud, title: "DNS only", body: "不開放橘雲代理，也不開 NS 委派。你的流量不經過我們。" },
  {
    icon: ShieldCheck,
    title: "公網位址才行",
    body: "A／AAAA 只接受公網位址，私有 IP 會被擋下，避免 DNS rebinding。",
  },
  {
    icon: Scale,
    title: "依風險審核",
    body: "新帳號或近似品牌的名稱才需要人工看一眼，其餘自動開通。",
  },
  { icon: Ban, title: "濫用零容忍", body: "釣魚、惡意程式一經檢舉成立就停權，DNS 紀錄立即撤下。" },
];

export function Principles() {
  return (
    <section aria-labelledby="rules-title" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <p className="zone text-sm text-ink-muted">
        <span className="text-beak">;</span> rules
      </p>
      <h2 id="rules-title" className="mt-2 text-step-4 font-semibold tracking-tight">
        規則很少，但寫得很清楚
      </h2>
      <ul className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {ITEMS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="border-t border-rule pt-5">
            <Icon className="size-5 text-magpie" aria-hidden />
            <h3 className="mt-3 font-semibold">{title}</h3>
            <p className="mt-1 text-sm text-ink-muted">{body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
