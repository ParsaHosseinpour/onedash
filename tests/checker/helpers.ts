import type {
  DnsLookupOptions,
  DnsResolver,
  ResolvedAddress,
} from "../../worker/checker/destination";
import type { MonitorCheckConfig } from "../../worker/checker/checker";
import { parseIpAddress } from "../../worker/checker/ip-policy";
import type {
  HttpRequestInput,
  HttpTransport,
  HttpTransportResponse,
} from "../../worker/checker/transport";

export function resolved(value: string): ResolvedAddress {
  const parsed = parseIpAddress(value);
  if (!parsed) throw new Error(`test address is invalid: ${value}`);
  return parsed;
}

export function baseConfig(
  overrides: Partial<MonitorCheckConfig> = {},
): MonitorCheckConfig {
  return {
    url: "https://example.com/health",
    method: "GET",
    expectedStatusCodes: [200],
    timeoutSeconds: 5,
    verifyTls: true,
    followRedirects: false,
    maxRedirects: 0,
    ...overrides,
  };
}

export function transportResponse(
  overrides: Partial<HttpTransportResponse> = {},
): HttpTransportResponse {
  return {
    statusCode: 200,
    location: null,
    contentLength: null,
    bytesRead: 0,
    timings: {
      connectMs: 4,
      tlsMs: 6,
      ttfbMs: 10,
    },
    ...overrides,
  };
}

export class FakeDnsResolver implements DnsResolver {
  readonly calls: Array<{ hostname: string; options: DnsLookupOptions }> = [];

  constructor(
    private readonly handler: (
      hostname: string,
      options: DnsLookupOptions,
      callIndex: number,
    ) => Promise<ResolvedAddress[]> | ResolvedAddress[],
  ) {}

  async resolve(
    hostname: string,
    options: DnsLookupOptions,
  ): Promise<ResolvedAddress[]> {
    const callIndex = this.calls.length;
    this.calls.push({ hostname, options });
    return this.handler(hostname, options, callIndex);
  }
}

export class FakeTransport implements HttpTransport {
  readonly calls: HttpRequestInput[] = [];

  constructor(
    private readonly handler: (
      input: HttpRequestInput,
      callIndex: number,
    ) => Promise<HttpTransportResponse> | HttpTransportResponse,
  ) {}

  async request(input: HttpRequestInput): Promise<HttpTransportResponse> {
    const callIndex = this.calls.length;
    this.calls.push(input);
    return this.handler(input, callIndex);
  }
}
