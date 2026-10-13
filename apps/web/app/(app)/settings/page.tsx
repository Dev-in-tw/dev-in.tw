import type { Metadata } from "next";
import { UserSettings } from "@/components/dashboard/user-settings.tsx";

export const metadata: Metadata = { title: "設定", robots: { index: false } };

export default function SettingsPage() {
  return <UserSettings />;
}
