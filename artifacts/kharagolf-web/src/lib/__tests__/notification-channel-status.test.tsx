import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  notificationStatusTone,
  NOTIFICATION_CHANNEL_LABEL,
  NOTIFICATION_CHANNEL_ORDER,
  NOTIFICATION_CHANNEL_ICON,
  ChannelStatusBadge,
} from "../notification-channel-status";

describe("notificationStatusTone", () => {
  it.each([
    ["sent", "emerald"],
    ["SENT", "emerald"],
    ["ok", "emerald"],
    ["delivered", "emerald"],
    ["failed", "red"],
    ["error", "red"],
    ["skipped", "amber"],
    ["blocked", "amber"],
    ["muted", "amber"],
    ["opted_out", "amber"],
    ["no_address", "amber"],
    ["queued", "sky"],
    ["pending", "sky"],
    ["digest", "sky"],
  ])("maps %s to the %s tone", (status, palette) => {
    expect(notificationStatusTone(status)).toContain(palette);
  });

  it("falls back to a neutral tone for unknown statuses", () => {
    expect(notificationStatusTone("mystery")).toContain("white/10");
  });
});

describe("NOTIFICATION_CHANNEL_LABEL", () => {
  it("knows every channel both surfaces previously rendered", () => {
    expect(NOTIFICATION_CHANNEL_LABEL.email).toBe("Email");
    expect(NOTIFICATION_CHANNEL_LABEL.in_app).toBe("In-app");
    expect(NOTIFICATION_CHANNEL_LABEL.push).toBe("Push");
    expect(NOTIFICATION_CHANNEL_LABEL.sms).toBe("SMS");
    expect(NOTIFICATION_CHANNEL_LABEL.whatsapp).toBe("WhatsApp");
    expect(NOTIFICATION_CHANNEL_LABEL.inapp).toBe("In-app");
    expect(NOTIFICATION_CHANNEL_LABEL.digest).toBe("Digest");
  });
});

describe("NOTIFICATION_CHANNEL_ORDER", () => {
  it("preserves the coach panel's email -> in_app -> push relative order", () => {
    const idx = (c: string) => NOTIFICATION_CHANNEL_ORDER.indexOf(c);
    expect(idx("email")).toBeLessThan(idx("in_app"));
    expect(idx("in_app")).toBeLessThan(idx("push"));
  });
});

describe("NOTIFICATION_CHANNEL_ICON", () => {
  it("provides icons for both `inapp` and `in_app` channel spellings", () => {
    expect(NOTIFICATION_CHANNEL_ICON.inapp).toBeDefined();
    expect(NOTIFICATION_CHANNEL_ICON.in_app).toBeDefined();
  });
});

describe("<ChannelStatusBadge>", () => {
  it("paints the badge with the unified tone class for the status", () => {
    const { container } = render(<ChannelStatusBadge status="sent" />);
    const badge = container.querySelector("div, span")!;
    expect(badge.className).toContain("emerald");
    expect(badge.className).toContain("capitalize");
  });

  it("forwards a data-testid", () => {
    const { container } = render(
      <ChannelStatusBadge status="failed" data-testid="audit-status-42" />,
    );
    expect(container.querySelector('[data-testid="audit-status-42"]')).not.toBeNull();
  });
});
