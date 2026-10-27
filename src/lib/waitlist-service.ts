import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizeEmail } from "@/lib/email";
import { ConfigurationError, getSupabasePublicEnv } from "@/lib/env";
import {
  checkRateLimit,
  type RateLimitDecision,
} from "@/lib/rate-limit";

export const WAITLIST_RATE_LIMIT = 5;
export const WAITLIST_RATE_WINDOW_MS = 10 * 60 * 1000;

export const WAITLIST_MESSAGES = {
  joined: "You're on the list! We'll email you when early access opens.",
  alreadyJoined: "You're already on the waitlist.",
  invalidEmail: "Enter a valid email address.",
  invalidSource: "That waitlist source is not accepted.",
  rateLimited: "Too many attempts. Please try again in a few minutes.",
  unavailable:
    "The waitlist is temporarily unavailable. Please try again later.",
  failed: "Something went wrong. Please try again.",
} as const;

export type WaitlistResult =
  | { status: "joined"; message: string }
  | { status: "already_joined"; message: string }
  | { status: "invalid_email"; message: string }
  | { status: "invalid_source"; message: string }
  | {
      status: "rate_limited";
      message: string;
      retryAfterSeconds: number;
    }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

export type WaitlistSubmission = {
  email: unknown;
  source?: unknown;
  ip?: string;
  /** Hidden honeypot field. Real users leave this empty. */
  website?: unknown;
};

export type WaitlistInsertRow = {
  email: string;
  source: "landing_page";
};

export type WaitlistInsertResult = {
  error: { code?: string } | null;
};

export type WaitlistInserter = (
  row: WaitlistInsertRow
) => Promise<WaitlistInsertResult>;

export type WaitlistDependencies = {
  insertRow?: WaitlistInserter;
  rateLimit?: (
    key: string,
    limit: number,
    windowMs: number,
    now?: number
  ) => RateLimitDecision;
  now?: () => number;
};

export function normalizeWaitlistSource(
  input: unknown
): "landing_page" | null {
  if (input === undefined || input === null || input === "") {
    return "landing_page";
  }

  return input === "landing_page" ? "landing_page" : null;
}

let waitlistClient: SupabaseClient | undefined;

function getWaitlistClient(): SupabaseClient {
  if (!waitlistClient) {
    const { url, anonKey } = getSupabasePublicEnv();
    waitlistClient = createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }

  return waitlistClient;
}

/**
 * The waitlist uses the public anon key, not a service-role key. RLS on the
 * waitlist table permits inserts only. This keeps the server route free of
 * secrets while still centralizing validation and rate limiting.
 */
export function createWaitlistInserter(): WaitlistInserter {
  return async (row) => {
    const { error } = await getWaitlistClient()
      .from("waitlist")
      .insert(row);

    return { error: error ? { code: error.code } : null };
  };
}

export async function submitWaitlist(
  input: WaitlistSubmission,
  deps: WaitlistDependencies = {}
): Promise<WaitlistResult> {
  // Silently accept honeypot submissions so bots do not learn they were
  // rejected, but do not write anything.
  if (
    input.website !== undefined &&
    input.website !== null &&
    String(input.website).trim() !== ""
  ) {
    return { status: "joined", message: WAITLIST_MESSAGES.joined };
  }

  const email = normalizeEmail(input.email);
  if (!email.ok) {
    return { status: "invalid_email", message: WAITLIST_MESSAGES.invalidEmail };
  }

  const source = normalizeWaitlistSource(input.source);
  if (!source) {
    return {
      status: "invalid_source",
      message: WAITLIST_MESSAGES.invalidSource,
    };
  }

  const ip =
    typeof input.ip === "string" && input.ip.trim()
      ? input.ip.trim().slice(0, 200)
      : "unknown";

  const limit = deps.rateLimit ?? checkRateLimit;
  const decision = limit(
    `waitlist:${ip}`,
    WAITLIST_RATE_LIMIT,
    WAITLIST_RATE_WINDOW_MS,
    deps.now?.()
  );

  if (!decision.allowed) {
    return {
      status: "rate_limited",
      message: WAITLIST_MESSAGES.rateLimited,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(decision.retryAfterMs / 1000)
      ),
    };
  }

  try {
    const insertRow = deps.insertRow ?? createWaitlistInserter();
    const { error } = await insertRow({ email: email.value, source });

    if (error?.code === "23505") {
      return {
        status: "already_joined",
        message: WAITLIST_MESSAGES.alreadyJoined,
      };
    }

    if (error) {
      console.error("Waitlist insert failed.", { code: error.code });
      return { status: "error", message: WAITLIST_MESSAGES.failed };
    }

    return { status: "joined", message: WAITLIST_MESSAGES.joined };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("Waitlist is not configured.", error.message);
      return {
        status: "unavailable",
        message: WAITLIST_MESSAGES.unavailable,
      };
    }

    console.error("Waitlist insert threw unexpectedly.", error);
    return { status: "error", message: WAITLIST_MESSAGES.failed };
  }
}
