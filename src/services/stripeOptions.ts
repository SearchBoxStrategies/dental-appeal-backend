import Stripe from 'stripe';

// Options for every Stripe client. STRIPE_API_BASE points the SDK at a local Stripe stand-in for
// end-to-end testing (e.g. http://localhost:3997); it is never set in production.
export function stripeOptions(): Stripe.StripeConfig {
  const options: Stripe.StripeConfig = { apiVersion: '2025-02-24.acacia' };
  const base = process.env.STRIPE_API_BASE;
  if (base) {
    const url = new URL(base);
    options.host = url.hostname;
    options.port = Number(url.port) || (url.protocol === 'http:' ? 80 : 443);
    options.protocol = url.protocol.replace(':', '') as 'http' | 'https';
  }
  return options;
}
