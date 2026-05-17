const PRINTFUL_API_BASE = "https://api.printful.com";

export interface PrintfulProduct {
  id: number;
  name: string;
  thumbnail_url: string;
  variants?: PrintfulVariant[];
}

export interface PrintfulVariant {
  id: number;
  name: string;
  retail_price: string;
  currency: string;
  size?: string;
  color?: string;
  availability_status: string;
}

export interface PrintfulOrderRecipient {
  name: string;
  email: string;
  address1: string;
  address2?: string;
  city: string;
  state_code: string;
  country_code: string;
  zip: string;
  phone?: string;
}

export interface PrintfulOrderItem {
  variant_id: number;
  quantity: number;
}

export interface PrintfulOrderResult {
  id: number;
  status: string;
  shipping: string;
  created: number;
}

function getApiKey(): string {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error("PRINTFUL_API_KEY environment variable not set");
  return key;
}

async function printfulFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const key = getApiKey();
  const res = await fetch(`${PRINTFUL_API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Printful API error ${res.status}: ${body}`);
  }
  const data = await res.json() as { result: T };
  return data.result;
}

export async function getStoreProducts(): Promise<PrintfulProduct[]> {
  return printfulFetch<PrintfulProduct[]>("/store/products");
}

export async function getProductVariants(productId: number): Promise<{ product: PrintfulProduct; variants: PrintfulVariant[] }> {
  return printfulFetch<{ product: PrintfulProduct; variants: PrintfulVariant[] }>(`/store/products/${productId}`);
}

export async function createPrintfulOrder(
  recipient: PrintfulOrderRecipient,
  items: PrintfulOrderItem[],
  externalId?: string,
): Promise<PrintfulOrderResult> {
  return printfulFetch<PrintfulOrderResult>("/orders", {
    method: "POST",
    body: JSON.stringify({
      external_id: externalId,
      recipient,
      items,
    }),
  });
}

export async function getOrderStatus(printfulOrderId: number): Promise<PrintfulOrderResult & { shipments?: Array<{ tracking_number: string; tracking_url: string }> }> {
  return printfulFetch(`/orders/${printfulOrderId}`);
}
