export const EMAIL_MAX_LENGTH = 254;

// Deliberately simple: the database and Supabase Auth perform their own
// checks. This rejects obviously malformed input without trying to implement
// the full RFC grammar.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "too_long" | "invalid" };

/**
 * Trim and lower-case an email address, then validate its shape.
 *
 * Lower-casing matches the database's case-insensitive unique index and
 * prevents duplicate waitlist rows that differ only by case.
 */
export function normalizeEmail(input: unknown): EmailValidation {
  if (typeof input !== "string") {
    return { ok: false, reason: "empty" };
  }

  const value = input.trim().toLowerCase();

  if (!value) {
    return { ok: false, reason: "empty" };
  }

  if (value.length > EMAIL_MAX_LENGTH) {
    return { ok: false, reason: "too_long" };
  }

  if (!EMAIL_PATTERN.test(value)) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, value };
}
