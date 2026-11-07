import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CheckerError,
  SAFE_MESSAGES,
  type MonitorCheckConfig,
} from "../../worker/checker";
import type { WorkerChecker } from "../../worker/checker/adapter";
import {
  buildCheckerChildEnv,
  CheckerProcessError,
  createProcessChecker,
  isFixtureTargetHost,
} from "../../worker/checker/process-client";
import { InvalidCheckerConfigError } from "../../worker/checker/config";

const childEntry = path.resolve("worker/checker/checker-child.ts");

function config(overrides: Partial<MonitorCheckConfig> = {}): MonitorCheckConfig {
  return {
    url: "https://fixture.test/health",
    method: "GET",
    expectedStatusCodes: [200],
    timeoutSeconds: 5,
    verifyTls: true,
    followRedirects: false,
    maxRedirects: 0,
    hasRequestSecrets: false,
    ...overrides,
  };
}

function checker(): WorkerChecker {
  return createProcessChecker({
    executionMode: "fixtures",
    allowedHosts: ["fixture.test"],
    childEntry,
    // Canaries that must never reach the child process.
    env: {
      ...process.env,
      ONEDASH_QUEUE_DATABASE_URL: "postgresql://queue:canary@db.test/postgres",
      ONEDASH_INGESTOR_DATABASE_URL:
        "postgresql://ingestor:canary@db.test/postgres",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-canary",
      DATABASE_URL: "postgresql://admin:canary@db.test/postgres",
      PGPASSWORD: "pg-password-canary",
      AWS_SECRET_ACCESS_KEY: "aws-canary",
    },
  });
}

describe("buildCheckerChildEnv", () => {
  it("passes only the minimal non-secret environment", () => {
    const env = buildCheckerChildEnv({
      PATH: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      NODE_ENV: "test",
      ONEDASH_QUEUE_DATABASE_URL: "postgresql://secret",
      SUPABASE_SERVICE_ROLE_KEY: "secret",
      DATABASE_URL: "postgresql://secret",
      PGPASSWORD: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      UNRELATED: "value",
    });

    expect(env).toEqual({
      PATH: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      NODE_ENV: "test",
    });
  });
});

describe("isFixtureTargetHost", () => {
  it.each([
    ["fixture.test", true],
    ["api.fixture.test", true],
    ["customer.example", false],
    ["localhost", false],
    ["api.localhost", false],
    ["127.0.0.1", false],
    ["192.0.2.1", false],
    ["test", false],
    [".test", false],
  ])("classifies %s as %s", (host, expected) => {
    expect(isFixtureTargetHost(host)).toBe(expected);
  });
});

describe("createProcessChecker", () => {
  it("rejects an allowlist containing a public destination", () => {
    expect(() =>
      createProcessChecker({
        executionMode: "fixtures",
        allowedHosts: ["customer.example"],
        childEntry,
      }),
    ).toThrow(CheckerProcessError);
  });

  it("rejects an empty allowlist", () => {
    expect(() =>
      createProcessChecker({
        executionMode: "fixtures",
        allowedHosts: [],
        childEntry,
      }),
    ).toThrow(CheckerProcessError);
  });

  it("rejects a monitor config with extra fields before spawning", async () => {
    const check = checker();
    await expect(
      check.check(
        { ...config(), leaseToken: "lease-canary" } as unknown as MonitorCheckConfig,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(InvalidCheckerConfigError);
  });

  it.each([
    "https://customer.example/health",
    "https://localhost/health",
    "https://127.0.0.1/health",
    "https://other.test/health",
  ])("blocks %s without spawning", async (url) => {
    const check = checker();
    await expect(
      check.check(config({ url }), new AbortController().signal),
    ).rejects.toMatchObject({ errorClass: "blocked_target" });
  });

  it("runs a fixture check in a credential-free child process", async () => {
    const check = checker();
    const result = await check.check(config(), new AbortController().signal);

    expect(result.status).toBe("up");
    expect(result.httpStatus).toBe(200);
    expect(result.errorClass).toBeNull();
  }, 30_000);

  it("does not expose parent secrets or lease identity to the child", async () => {
    const check = createProcessChecker({
      executionMode: "fixtures",
      allowedHosts: ["fixture.test"],
      childEntry: path.resolve(
        "tests/worker/fixtures/isolation-probe-child.ts",
      ),
      env: {
        ...process.env,
        ONEDASH_QUEUE_DATABASE_URL: "postgresql://queue:canary@db.test/postgres",
        ONEDASH_INGESTOR_DATABASE_URL:
          "postgresql://ingestor:canary@db.test/postgres",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-canary",
        DATABASE_URL: "postgresql://admin:canary@db.test/postgres",
        PGPASSWORD: "pg-password-canary",
        AWS_SECRET_ACCESS_KEY: "aws-canary",
      },
    });

    const result = await check.check(config(), new AbortController().signal);
    expect(result).toMatchObject({ status: "up", responseBytes: 0 });
  }, 30_000);

  it("does not expose the parent checker to customer execution", async () => {
    const check = createProcessChecker({
      executionMode: "disabled",
      allowedHosts: ["fixture.test"],
      childEntry,
    });

    await expect(
      check.check(config(), new AbortController().signal),
    ).rejects.toMatchObject({ errorClass: "blocked_target" });
  }, 30_000);
});

describe("CheckerError", () => {
  it("replaces an unsafe error message sent by a child process", async () => {
    const check = createProcessChecker({
      executionMode: "fixtures",
      allowedHosts: ["fixture.test"],
      childEntry: path.resolve("tests/worker/fixtures/unsafe-error-child.ts"),
    });

    await expect(
      check.check(config(), new AbortController().signal),
    ).rejects.toMatchObject({
      errorClass: "timeout",
      message: SAFE_MESSAGES.timeout,
    });
    await expect(
      check.check(config(), new AbortController().signal),
    ).rejects.toBeInstanceOf(CheckerError);
  }, 30_000);
});
