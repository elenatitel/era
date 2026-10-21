import Stripe from 'stripe';
import { config } from '../config.js';

/** A Stripe client for one hotel's account. STRIPE_API_BASE points tests at a local fake. */
export function stripeFor(secretKey: string): Stripe {
  const c = config();
  const base = !c.isProduction && c.STRIPE_API_BASE ? new URL(c.STRIPE_API_BASE) : null;
  return new Stripe(secretKey, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
    ...(base
      ? { host: base.hostname, port: Number(base.port || (base.protocol === 'https:' ? 443 : 80)), protocol: base.protocol.replace(':', '') as 'http' | 'https' }
      : {}),
  });
}

export type PaymentIntent = Stripe.PaymentIntent;
export type StripeEvent = Stripe.Event;
