import { createHmac } from "crypto";

const DSERS_API_BASE = "https://openapi.dsers.com/open/api";

export interface DsersAddress {
  name: string;
  email: string;
  phone: string;
  country: string;
  province: string;
  city: string;
  address1: string;
  address2?: string;
  zip: string;
}

export interface DsersOrderItem {
  sku_id: string;
  quantity: number;
  product_url?: string;
}

export interface DsersOrderResult {
  order_id: string;
  status: string;
  tracking_number?: string;
  tracking_company?: string;
  tracking_url?: string;
}

function getCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.DSERS_APP_ID;
  const appSecret = process.env.DSERS_APP_SECRET;
  if (!appId) throw new Error("DSERS_APP_ID environment variable not set");
  if (!appSecret) throw new Error("DSERS_APP_SECRET environment variable not set");
  return { appId, appSecret };
}

function buildSignature(appSecret: string, timestamp: number, body: string): string {
  const content = `${timestamp}${body}`;
  return createHmac("sha256", appSecret).update(content).digest("hex");
}

async function dsersFetch<T>(path: string, opts: RequestInit = {}, body?: object): Promise<T> {
  const { appId, appSecret } = getCredentials();
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyStr = body ? JSON.stringify(body) : "";
  const signature = buildSignature(appSecret, timestamp, bodyStr);

  const res = await fetch(`${DSERS_API_BASE}${path}`, {
    ...opts,
    body: bodyStr || undefined,
    headers: {
      "Content-Type": "application/json",
      "Dsers-App-Id": appId,
      "Dsers-Timestamp": String(timestamp),
      "Dsers-Signature": signature,
      ...(opts.headers ?? {}),
    },
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`DSers API error ${res.status}: ${errBody}`);
  }
  const json = await res.json() as { code: number; message: string; data: T };
  if (json.code !== 0) {
    throw new Error(`DSers API error code ${json.code}: ${json.message}`);
  }
  return json.data;
}

export async function createDsersOrder(
  address: DsersAddress,
  items: DsersOrderItem[],
  externalId?: string,
): Promise<DsersOrderResult> {
  return dsersFetch<DsersOrderResult>(
    "/order/create",
    { method: "POST" },
    {
      platform_order_id: externalId,
      shipping_address: address,
      line_items: items,
    },
  );
}

export async function getDsersOrderStatus(orderId: string): Promise<DsersOrderResult> {
  return dsersFetch<DsersOrderResult>(`/order/detail?order_id=${orderId}`, { method: "GET" });
}
