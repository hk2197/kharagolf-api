const PRINTIFY_API_BASE = "https://api.printify.com/v1";

export interface PrintifyProduct {
  id: string;
  title: string;
  images: { src: string }[];
  variants: PrintifyVariant[];
}

export interface PrintifyVariant {
  id: number;
  title: string;
  price: number;
  is_available: boolean;
}

export interface PrintifyOrderRecipient {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  country: string;
  region: string;
  address1: string;
  address2?: string;
  city: string;
  zip: string;
}

export interface PrintifyOrderLineItem {
  print_provider_id?: number;
  blueprint_id?: number;
  variant_id: number;
  print_areas?: Record<string, unknown>;
  quantity: number;
  product_id?: string;
}

export interface PrintifyOrderResult {
  id: string;
  status: string;
  line_items: { variant_id: number; quantity: number }[];
  shipments?: Array<{
    carrier: string;
    tracking_number: string;
    tracking_url: string;
  }>;
}

function getCredentials(): { apiKey: string; shopId: string } {
  const apiKey = process.env.PRINTIFY_API_KEY;
  const shopId = process.env.PRINTIFY_SHOP_ID;
  if (!apiKey) throw new Error("PRINTIFY_API_KEY environment variable not set");
  if (!shopId) throw new Error("PRINTIFY_SHOP_ID environment variable not set");
  return { apiKey, shopId };
}

async function printifyFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const { apiKey, shopId } = getCredentials();
  const url = path.startsWith("/shops")
    ? `${PRINTIFY_API_BASE}${path}`
    : `${PRINTIFY_API_BASE}/shops/${shopId}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Printify API error ${res.status}: ${body}`);
  }
  return await res.json() as T;
}

export async function getShopProducts(): Promise<{ data: PrintifyProduct[] }> {
  return printifyFetch<{ data: PrintifyProduct[] }>("/products.json");
}

export async function createPrintifyOrder(
  recipient: PrintifyOrderRecipient,
  lineItems: PrintifyOrderLineItem[],
  externalId?: string,
): Promise<PrintifyOrderResult> {
  return printifyFetch<PrintifyOrderResult>("/orders.json", {
    method: "POST",
    body: JSON.stringify({
      external_id: externalId,
      label: externalId,
      line_items: lineItems,
      shipping_method: 1,
      is_printify_express: false,
      is_economy_shipping: false,
      send_shipping_notification: true,
      address_to: recipient,
    }),
  });
}

export async function getPrintifyOrderStatus(orderId: string): Promise<PrintifyOrderResult> {
  return printifyFetch<PrintifyOrderResult>(`/orders/${orderId}.json`);
}

export async function sendPrintifyOrderToProduction(orderId: string): Promise<void> {
  await printifyFetch(`/orders/${orderId}/send_to_production.json`, { method: "POST" });
}
