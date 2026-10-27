export const DEFAULT_POST_LOGIN_PATH = "/dashboard";
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

const ALLOWED_POST_LOGIN_PATHS = new Set([DEFAULT_POST_LOGIN_PATH]);

export type PasswordValidation =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Password rules are enforced on the server in the signup action. The client
 * only mirrors the same message as a hint; it is not the authority.
 */
export function validatePassword(password: string): PasswordValidation {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    };
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    };
  }

  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return {
      ok: false,
      message: "Password must include at least one letter and one number.",
    };
  }

  return { ok: true };
}

/**
 * Only allow a small set of known post-login destinations. This prevents an
 * attacker from using the login flow as an open redirect, including tricks
 * with absolute URLs, protocol-relative URLs, backslashes, and encoded values.
 */
export function sanitizeNextPath(
  input: FormDataEntryValue | string | null | undefined
): string {
  if (typeof input !== "string" || input.length === 0) {
    return DEFAULT_POST_LOGIN_PATH;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return DEFAULT_POST_LOGIN_PATH;
  }

  if (!decoded.startsWith("/") || decoded.startsWith("//")) {
    return DEFAULT_POST_LOGIN_PATH;
  }

  if (decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) {
    return DEFAULT_POST_LOGIN_PATH;
  }

  let url: URL;
  try {
    url = new URL(decoded, "https://onedash.invalid");
  } catch {
    return DEFAULT_POST_LOGIN_PATH;
  }

  if (url.origin !== "https://onedash.invalid") {
    return DEFAULT_POST_LOGIN_PATH;
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";

  return ALLOWED_POST_LOGIN_PATHS.has(path) ? path : DEFAULT_POST_LOGIN_PATH;
}

export type LoginState =
  | { status: "idle" }
  | { status: "error"; message: string; email?: string };

export type SignupState =
  | { status: "idle" }
  | { status: "error"; message: string; email?: string }
  | { status: "success"; message: string; email: string };

export const initialLoginState: LoginState = { status: "idle" };
export const initialSignupState: SignupState = { status: "idle" };
