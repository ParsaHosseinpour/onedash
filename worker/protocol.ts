/**
 * Small, strict JSON protocol parsers for database function responses.
 *
 * A malformed response is a programming or deployment error, not customer
 * data. Errors contain only the field name and never echo the value, because
 * a value could contain a URL or secret if a function is accidentally changed.
 */

export class ProtocolError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`invalid database response field: ${field}`);
    this.name = "ProtocolError";
    this.field = field;
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("object");
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError(field);
  }
  return value;
}

export function asNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ProtocolError(field);
  return value;
}

export function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(field);
  }
  return value;
}

export function asNullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, field);
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ProtocolError(field);
  return value;
}

export function asNumberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) throw new ProtocolError(field);
  return value.map((item) => asNumber(item, field));
}

export function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new ProtocolError(field);
  return value.map((item) => asString(item, field));
}

export function asEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProtocolError(field);
  }
  return value as T;
}
