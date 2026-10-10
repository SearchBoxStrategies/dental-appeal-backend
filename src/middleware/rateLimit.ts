import { Request, Response, NextFunction } from 'express';

// Small in-memory rate limiter (fixed window). Enough for a single API instance; counts reset
// when the process restarts. Kept dependency-free so deploys don't rely on new packages.

interface Options {
  name: string;
  windowMs: number;
  max: number;
  // What to count requests by. Defaults to the client IP. Return undefined to skip limiting.
  key?: (req: Request) => string | undefined;
  message?: string;
}

const buckets = new Map<string, { count: number; resetAt: number }>();

// Drop expired buckets every minute so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

export function rateLimit({ name, windowMs, max, key, message }: Options) {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = key ? key(req) : req.ip;
    if (!id) return next();

    const bucketKey = `${name}:${id}`;
    const now = Date.now();
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count++;

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      console.warn(`⛔ Rate limit "${name}" hit by ${req.ip} on ${req.method} ${req.originalUrl}`);
      return res.status(429).json({
        error: message || 'Too many requests. Please wait a few minutes and try again.',
        retryAfterSeconds: retryAfter,
      });
    }
    next();
  };
}

const lower = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined);

// Login, signup, password and verification endpoints: per client IP.
export const authLimiter = rateLimit({ name: 'auth', windowMs: 15 * 60_000, max: 20 });

// Password guessing against one account from many IPs.
export const loginPerAccountLimiter = rateLimit({
  name: 'login-account',
  windowMs: 15 * 60_000,
  max: 10,
  key: req => lower(req.body?.email),
  message: 'Too many sign-in attempts for this account. Please wait 15 minutes or reset your password.',
});

// Guessing an admin's 6-digit code.
export const twoFactorLimiter = rateLimit({
  name: '2fa',
  windowMs: 10 * 60_000,
  max: 5,
  key: req => (req.body?.userId != null ? String(req.body.userId) : undefined),
  message: 'Too many verification attempts. Please wait 10 minutes and request a new code.',
});

// Public form that sends email: per sender IP, and per recipient address.
export const emailFormLimiter = rateLimit({ name: 'email-form', windowMs: 60 * 60_000, max: 5 });
export const emailRecipientLimiter = rateLimit({
  name: 'email-recipient',
  windowMs: 24 * 60 * 60_000,
  max: 3,
  key: req => lower(req.body?.email),
  message: 'A report has already been sent to this address today.',
});

// Affiliate link clicks create tracking rows.
export const trackLimiter = rateLimit({ name: 'track', windowMs: 60_000, max: 30 });

// Overall ceiling per IP for the whole API.
export const apiLimiter = rateLimit({ name: 'api', windowMs: 60_000, max: 300 });
