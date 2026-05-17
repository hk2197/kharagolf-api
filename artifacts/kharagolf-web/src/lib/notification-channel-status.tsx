import React from "react";
import { Mail, Bell, MessageSquare, Smartphone, Inbox, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function notificationStatusTone(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("sent") || s === "ok" || s === "delivered") {
    return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  }
  if (s.includes("fail") || s === "error") {
    return "bg-red-500/15 text-red-300 border-red-500/30";
  }
  if (
    s.includes("skip") ||
    s === "blocked" ||
    s === "muted" ||
    s === "opted_out" ||
    s === "no_address"
  ) {
    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  }
  if (s.includes("queue") || s === "pending" || s === "digest") {
    return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  }
  return "bg-white/10 text-white/70 border-white/20";
}

export const NOTIFICATION_CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  push: "Push",
  sms: "SMS",
  whatsapp: "WhatsApp",
  in_app: "In-app",
  inapp: "In-app",
  digest: "Digest",
};

// Channels not in this list render after these in insertion order.
export const NOTIFICATION_CHANNEL_ORDER: readonly string[] = [
  "email",
  "in_app",
  "push",
  "inapp",
  "sms",
  "whatsapp",
  "digest",
];

export const NOTIFICATION_CHANNEL_ICON: Record<string, React.ReactNode> = {
  email: <Mail className="w-3.5 h-3.5" />,
  push: <Bell className="w-3.5 h-3.5" />,
  sms: <Smartphone className="w-3.5 h-3.5" />,
  whatsapp: <MessageSquare className="w-3.5 h-3.5" />,
  inapp: <Inbox className="w-3.5 h-3.5" />,
  in_app: <Inbox className="w-3.5 h-3.5" />,
  digest: <Layers className="w-3.5 h-3.5" />,
};

export function ChannelStatusBadge({
  status,
  className,
  "data-testid": testId,
}: {
  status: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={`capitalize ${notificationStatusTone(status)}${className ? ` ${className}` : ""}`}
      data-testid={testId}
    >
      {status}
    </Badge>
  );
}
