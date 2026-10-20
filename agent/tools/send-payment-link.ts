import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Create a Stripe payment link and return the URL. Requires STRIPE_SECRET_KEY env var. Uses Stripe test mode if the key starts with 'sk_test_'. Returns null if key is not set.",
  inputSchema: z.object({
    amount_cents: z.number().int().min(50).describe("Amount in cents (e.g. 9900 = $99.00)"),
    currency: z.string().length(3).default("usd").describe("ISO 4217 currency code"),
    product_name: z.string().min(1).describe("Product or service name shown to the buyer"),
    quantity: z.number().int().min(1).default(1).describe("Quantity"),
  }),
  async execute({ amount_cents, currency, product_name, quantity }) {
    const key = process.env["STRIPE_SECRET_KEY"];
    if (!key) {
      return {
        payment_url: null,
        note: "Set STRIPE_SECRET_KEY to enable payment link generation. Use sk_test_... for test mode.",
      };
    }

    const auth = `Basic ${Buffer.from(`${key}:`).toString("base64")}`;

    // Step 1: Create price
    const priceBody = new URLSearchParams({
      "unit_amount": String(amount_cents),
      "currency": currency,
      "product_data[name]": product_name,
    });
    try {
      const priceRes = await fetch("https://api.stripe.com/v1/prices", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: priceBody.toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (!priceRes.ok) {
        const e = await priceRes.json() as { error?: { message?: string } };
        return { payment_url: null, error: e?.error?.message ?? `Stripe error ${priceRes.status}` };
      }
      const price = await priceRes.json() as { id: string };

      // Step 2: Create payment link
      const linkBody = new URLSearchParams({
        "line_items[0][price]": price.id,
        "line_items[0][quantity]": String(quantity),
      });
      const linkRes = await fetch("https://api.stripe.com/v1/payment_links", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: linkBody.toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (!linkRes.ok) {
        const e = await linkRes.json() as { error?: { message?: string } };
        return { payment_url: null, error: e?.error?.message ?? `Stripe error ${linkRes.status}` };
      }
      const link = await linkRes.json() as { url: string; id: string };
      return { payment_url: link.url, payment_link_id: link.id, provider: "stripe", test_mode: key.startsWith("sk_test_") };
    } catch (e) {
      return { payment_url: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
});
