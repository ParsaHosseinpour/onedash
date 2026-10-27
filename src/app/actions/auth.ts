"use server";

import { redirect } from "next/navigation";
import { clearSupabaseAuthCookies } from "@/lib/auth";
import {
  sanitizeNextPath,
  validatePassword,
  PASSWORD_MAX_LENGTH,
  type LoginState,
  type SignupState,
} from "@/lib/auth-validation";
import { normalizeEmail } from "@/lib/email";
import { ConfigurationError, getSiteUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

const AUTH_UNAVAILABLE_MESSAGE =
  "Authentication is temporarily unavailable. Please try again later.";

const SIGNUP_ACCEPTED_MESSAGE =
  "If this email can be registered, a confirmation link is on its way. If you already have an account, log in instead.";

function isRateLimited(code?: string): boolean {
  return (
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit" ||
    code === "too_many_requests"
  );
}

function signInErrorMessage(code?: string): string {
  if (code === "email_not_confirmed") {
    return "Please confirm your email address before logging in.";
  }

  if (isRateLimited(code)) {
    return "Too many attempts. Please try again later.";
  }

  // Do not distinguish between an unknown email and a wrong password.
  return "Invalid email or password.";
}

function isExistingAccountError(
  code: string | undefined,
  message: string
): boolean {
  return (
    code === "user_already_exists" ||
    code === "email_exists" ||
    /already registered/i.test(message)
  );
}

function signUpErrorMessage(code: string | undefined): string {
  if (code === "weak_password") {
    return "That password does not meet the account requirements.";
  }

  if (code === "email_address_invalid") {
    return "Enter a valid email address.";
  }

  if (isRateLimited(code)) {
    return "Too many attempts. Please try again later.";
  }

  return "We couldn't create your account. Please try again.";
}

export async function signInAction(
  _previousState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = normalizeEmail(formData.get("email"));
  const password = String(formData.get("password") ?? "");
  const nextPath = sanitizeNextPath(formData.get("next"));

  if (!email.ok || !password || password.length > PASSWORD_MAX_LENGTH) {
    return {
      status: "error",
      message: "Enter a valid email and password.",
      email: email.ok ? email.value : undefined,
    };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: email.value,
      password,
    });

    if (error) {
      console.error("Sign-in failed.", { code: error.code });
      return {
        status: "error",
        message: signInErrorMessage(error.code),
        email: email.value,
      };
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("Sign-in is unavailable.", error.message);
    } else {
      console.error("Sign-in threw unexpectedly.", error);
    }

    return {
      status: "error",
      message: AUTH_UNAVAILABLE_MESSAGE,
      email: email.value,
    };
  }

  redirect(nextPath);
}

export async function signUpAction(
  _previousState: SignupState,
  formData: FormData
): Promise<SignupState> {
  const rawEmail = formData.get("email");
  const email = normalizeEmail(rawEmail);
  const password = String(formData.get("password") ?? "");
  const fallbackEmail =
    typeof rawEmail === "string"
      ? rawEmail.trim().toLowerCase()
      : undefined;

  if (!email.ok) {
    return {
      status: "error",
      message: "Enter a valid email address.",
      email: fallbackEmail,
    };
  }

  const passwordResult = validatePassword(password);
  if (!passwordResult.ok) {
    return {
      status: "error",
      message: passwordResult.message,
      email: email.value,
    };
  }

  let callbackUrl: string;
  try {
    callbackUrl = new URL("/auth/callback", getSiteUrl()).toString();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("Sign-up is unavailable.", error.message);
    } else {
      console.error("Could not build the auth callback URL.", error);
    }

    return {
      status: "error",
      message: AUTH_UNAVAILABLE_MESSAGE,
      email: email.value,
    };
  }

  let createdSession = false;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signUp({
      email: email.value,
      password,
      options: {
        emailRedirectTo: callbackUrl,
      },
    });

    if (error) {
      // Return the same success-shaped response for an existing account as for
      // a new one. This avoids turning signup into an account-enumeration API.
      if (isExistingAccountError(error.code, error.message)) {
        return {
          status: "success",
          message: SIGNUP_ACCEPTED_MESSAGE,
          email: email.value,
        };
      }

      console.error("Sign-up failed.", { code: error.code });
      return {
        status: "error",
        message: signUpErrorMessage(error.code),
        email: email.value,
      };
    }

    // Projects with email confirmation disabled return a session immediately.
    // In that case the user is already signed in; go straight to the app.
    createdSession = Boolean(data?.session);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("Sign-up is unavailable.", error.message);
    } else {
      console.error("Sign-up threw unexpectedly.", error);
    }

    return {
      status: "error",
      message: AUTH_UNAVAILABLE_MESSAGE,
      email: email.value,
    };
  }

  if (createdSession) {
    redirect("/dashboard");
  }

  return {
    status: "success",
    message: SIGNUP_ACCEPTED_MESSAGE,
    email: email.value,
  };
}

export async function signOutAction(): Promise<{
  ok: boolean;
  message?: string;
}> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error("Supabase sign-out failed.", { code: error.code });
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("Sign-out is unavailable.", error.message);
    } else {
      console.error("Sign-out threw unexpectedly.", error);
    }
  }

  try {
    await clearSupabaseAuthCookies();
  } catch (error) {
    console.error("Failed to clear Supabase auth cookies.", error);
    return {
      ok: false,
      message: "We couldn't fully log you out. Please try again.",
    };
  }

  return { ok: true };
}
