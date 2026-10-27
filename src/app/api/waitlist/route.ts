import { NextResponse, type NextRequest } from "next/server";
import { submitWaitlist } from "@/lib/waitlist-service";

function getClientIp(request: NextRequest): string {
  // These headers are trustworthy only behind a proxy that overwrites them.
  // The in-process limiter is a speed bump, not a security boundary.
  const forwarded = request.headers.get("x-forwarded-for");
  const firstForwarded = forwarded?.split(",")[0]?.trim();

  return (
    firstForwarded ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, message: "Invalid request." },
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { ok: false, message: "Invalid request." },
      { status: 400 }
    );
  }

  const payload = body as Record<string, unknown>;

  const result = await submitWaitlist({
    email: payload.email,
    source: payload.source,
    website: payload.website,
    ip: getClientIp(request),
  });

  switch (result.status) {
    case "joined":
      return NextResponse.json({
        ok: true,
        alreadyJoined: false,
        message: result.message,
      });

    case "already_joined":
      return NextResponse.json({
        ok: true,
        alreadyJoined: true,
        message: result.message,
      });

    case "invalid_email":
    case "invalid_source":
      return NextResponse.json(
        { ok: false, message: result.message },
        { status: 400 }
      );

    case "rate_limited":
      return NextResponse.json(
        { ok: false, message: result.message },
        {
          status: 429,
          headers: {
            "Retry-After": String(result.retryAfterSeconds),
          },
        }
      );

    case "unavailable":
      return NextResponse.json(
        { ok: false, message: result.message },
        { status: 503 }
      );

    case "error":
    default:
      return NextResponse.json(
        { ok: false, message: result.message },
        { status: 500 }
      );
  }
}
