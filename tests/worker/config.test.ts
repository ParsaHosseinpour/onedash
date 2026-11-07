import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  isFixtureHostname,
  isValidHostname,
  isValidRegion,
  loadSchedulerConfig,
  loadWorkerConfig,
} from "../../worker/config";

const baseEnv = {
  ONEDASH_QUEUE_DATABASE_URL: "postgresql://queue:secret@db.example.test:5432/postgres",
  ONEDASH_INGESTOR_DATABASE_URL:
    "postgresql://ingestor:secret@db.example.test:5432/postgres",
  ONEDASH_SCHEDULER_DATABASE_URL:
    "postgresql://scheduler:secret@db.example.test:5432/postgres",
};

describe("loadWorkerConfig", () => {
  it("defaults to disabled mode", () => {
    const config = loadWorkerConfig(baseEnv);
    expect(config.executionMode).toBe("disabled");
    expect(config.fixtureHosts).toEqual([]);
    expect(config.concurrency).toBe(2);
    expect(config.healthHost).toBe("127.0.0.1");
  });

  it("rejects customer mode explicitly", () => {
    expect(() =>
      loadWorkerConfig({
        ...baseEnv,
        ONEDASH_WORKER_EXECUTION_MODE: "customer",
      }),
    ).toThrow(/NOT IMPLEMENTED/);
  });

  it("requires an explicit fixture host allowlist in fixtures mode", () => {
    expect(() =>
      loadWorkerConfig({
        ...baseEnv,
        ONEDASH_WORKER_EXECUTION_MODE: "fixtures",
      }),
    ).toThrow(/ONEDASH_FIXTURE_HOSTS/);
  });

  it("accepts fixtures mode with .test hosts", () => {
    const config = loadWorkerConfig({
      ...baseEnv,
      ONEDASH_WORKER_EXECUTION_MODE: "fixtures",
      ONEDASH_FIXTURE_HOSTS: "fixture.test, api.fixture.test",
      ONEDASH_WORKER_CONCURRENCY: "3",
      ONEDASH_LEASE_SECONDS: "60",
    });
    expect(config.executionMode).toBe("fixtures");
    expect(config.fixtureHosts).toEqual(["fixture.test", "api.fixture.test"]);
    expect(config.concurrency).toBe(3);
    expect(config.leaseSeconds).toBe(60);
  });

  it("rejects invalid fixture hostnames", () => {
    expect(() =>
      loadWorkerConfig({
        ...baseEnv,
        ONEDASH_WORKER_EXECUTION_MODE: "fixtures",
        ONEDASH_FIXTURE_HOSTS: "https://fixture.test",
      }),
    ).toThrow(/invalid hostname/);
  });

  it.each(["customer.example", "localhost", "api.localhost", "127.0.0.1"])(
    "rejects non-.test fixture host %s",
    (host) => {
      expect(() =>
        loadWorkerConfig({
          ...baseEnv,
          ONEDASH_WORKER_EXECUTION_MODE: "fixtures",
          ONEDASH_FIXTURE_HOSTS: host,
        }),
      ).toThrow(/\.test/);
    },
  );

  it("rejects a region outside the bounded registry", () => {
    expect(() =>
      loadWorkerConfig({
        ...baseEnv,
        ONEDASH_REGION: "moon-1",
      }),
    ).toThrow(/supported region/);
  });

  it("requires a metrics token for non-loopback health binding", () => {
    expect(() =>
      loadWorkerConfig({
        ...baseEnv,
        ONEDASH_HEALTH_HOST: "0.0.0.0",
      }),
    ).toThrow(/ONEDASH_METRICS_TOKEN/);
  });

  it("rejects a short metrics token", () => {
    expect(() =>
      loadWorkerConfig({
        ...baseEnv,
        ONEDASH_METRICS_TOKEN: "short",
      }),
    ).toThrow(/at least 16/);
  });

  it("does not echo database URLs or passwords in validation errors", () => {
    try {
      loadWorkerConfig({
        ONEDASH_QUEUE_DATABASE_URL: "not-a-url-with-password",
        ONEDASH_INGESTOR_DATABASE_URL: "postgresql://user:secret@example.test/db",
      });
      throw new Error("expected configuration failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain("secret");
      expect((error as Error).message).not.toContain("password");
    }
  });

  it("validates numeric bounds", () => {
    expect(() =>
      loadWorkerConfig({ ...baseEnv, ONEDASH_WORKER_CONCURRENCY: "99" }),
    ).toThrow(/between 1 and 10/);
    expect(() =>
      loadWorkerConfig({ ...baseEnv, ONEDASH_HEALTH_PORT: "0" }),
    ).toThrow(/between 1 and 65535/);
  });
});

describe("loadSchedulerConfig", () => {
  it("loads defaults", () => {
    const config = loadSchedulerConfig(baseEnv);
    expect(config.schedulerId).toMatch(/^scheduler-/);
    expect(config.region).toBe("global");
    expect(config.batchSize).toBe(50);
    expect(config.jitterSeconds).toBe(10);
  });

  it("rejects an invalid region", () => {
    expect(() =>
      loadSchedulerConfig({ ...baseEnv, ONEDASH_SCHEDULER_REGION: "US East" }),
    ).toThrow(/lowercase/);
  });

  it("rejects an unsupported scheduler region", () => {
    expect(() =>
      loadSchedulerConfig({ ...baseEnv, ONEDASH_SCHEDULER_REGION: "moon-1" }),
    ).toThrow(/supported region/);
  });
});

describe("hostname and region validation", () => {
  it("accepts simple hostnames", () => {
    expect(isValidHostname("fixture.test")).toBe(true);
    expect(isValidHostname("api-1.fixture.test")).toBe(true);
  });

  it("rejects malformed hostnames", () => {
    expect(isValidHostname("-fixture.test")).toBe(false);
    expect(isValidHostname("fixture..test")).toBe(false);
    expect(isValidHostname("fixture_test")).toBe(false);
  });

  it("accepts safe region identifiers", () => {
    expect(isValidRegion("us-east-1")).toBe(true);
    expect(isValidRegion("test-1")).toBe(true);
  });

  it("rejects unsafe region identifiers", () => {
    expect(isValidRegion("US")).toBe(false);
    expect(isValidRegion("us_east")).toBe(false);
  });

  it("accepts only .test fixture hostnames", () => {
    expect(isFixtureHostname("fixture.test")).toBe(true);
    expect(isFixtureHostname("api.fixture.test")).toBe(true);
    expect(isFixtureHostname("customer.example")).toBe(false);
    expect(isFixtureHostname("localhost")).toBe(false);
    expect(isFixtureHostname("api.localhost")).toBe(false);
    expect(isFixtureHostname("127.0.0.1")).toBe(false);
    expect(isFixtureHostname(".test")).toBe(false);
  });
});
