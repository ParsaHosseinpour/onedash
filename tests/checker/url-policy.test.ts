import { describe, expect, it } from "vitest";
import {
  RedirectError,
  UnsafeTargetError,
  UnsupportedConfigurationError,
} from "../../worker/checker/errors";
import { resolveCheckerLimits } from "../../worker/checker/limits";
import {
  parseRedirectTarget,
  validateTargetUrl,
} from "../../worker/checker/url-policy";

const limits = resolveCheckerLimits();

function valid(raw: string) {
  return validateTargetUrl(raw, limits);
}

describe("target URL policy", () => {
  it("accepts absolute HTTP and HTTPS URLs", () => {
    expect(valid("http://example.com").url.toString()).toBe(
      "http://example.com/",
    );
    expect(valid("https://example.com/health?probe=1").canonical).toBe(
      "https://example.com/health?probe=1",
    );
    expect(valid("https://example.com:443/health").port).toBe(443);
    expect(valid("http://example.com:80/health").port).toBe(80);
  });

  it("normalizes a trailing root dot and strips fragments", () => {
    const target = valid("https://Example.COM./health#section");
    expect(target.hostname).toBe("example.com");
    expect(target.url.toString()).toBe("https://example.com/health");
    expect(target.canonical).not.toContain("#");
  });

  it("recognizes public IP literals", () => {
    const ipv4 = valid("https://8.8.8.8/health");
    expect(ipv4.isIpLiteral).toBe(true);
    expect(ipv4.ipLiteral).toEqual({ address: "8.8.8.8", family: 4 });

    const ipv6 = valid("https://[2606:4700:4700::1111]/health");
    expect(ipv6.isIpLiteral).toBe(true);
    expect(ipv6.ipLiteral).toEqual({
      address: "2606:4700:4700::1111",
      family: 6,
    });
  });

  it("normalizes unusual numeric IPv4 forms before the address policy runs", () => {
    for (const raw of [
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0177.0.0.1/",
      "http://127.1/",
    ]) {
      const target = valid(raw);
      expect(target.isIpLiteral).toBe(true);
      expect(target.ipLiteral?.address).toBe("127.0.0.1");
    }
  });

  it("leaves private IP literals for the destination policy", () => {
    const target = valid("http://127.0.0.1/");
    expect(target.isIpLiteral).toBe(true);
    expect(target.ipLiteral?.address).toBe("127.0.0.1");
  });

  it.each([
    "ftp://example.com/file",
    "file:///etc/passwd",
    "http://user:pass@example.com/",
    "http://example.com:8080/",
    "http://foo/",
    "http://exa_mple.com/",
    "http://-example.com/",
    "http://example-.com/",
    "http://example..com/",
    "http://example.123/",
    "http://1.2.3.4.5/",
    "http://example.com/ path",
    "http://example.com/\tpath",
    "http://example.com\\@127.0.0.1/",
    "http://example.com/\u0000",
    "example.com",
    "http://",
    "",
  ])("rejects unsupported or ambiguous URL %s", (raw) => {
    expect(() => valid(raw)).toThrow(UnsupportedConfigurationError);
  });

  it("rejects host suffixes that are never public targets", () => {
    for (const raw of [
      "http://localhost/",
      "http://foo.local/",
      "http://foo.internal/",
      "http://foo.home.arpa/",
      "http://intranet/",
    ]) {
      expect(() => valid(raw)).toThrow(UnsafeTargetError);
    }
  });

  it("rejects URLs longer than the configured maximum", () => {
    const long = `https://example.com/${"a".repeat(limits.maxUrlLength)}`;
    expect(() => valid(long)).toThrow(UnsupportedConfigurationError);
  });

  it("resolves safe relative and absolute redirects", () => {
    const base = valid("https://example.com/start").url;
    expect(parseRedirectTarget("/next", base, limits).canonical).toBe(
      "https://example.com/next",
    );
    expect(
      parseRedirectTarget("https://other.example/path", base, limits).canonical,
    ).toBe("https://other.example/path");
    expect(parseRedirectTarget("//other.example/path", base, limits).canonical).toBe(
      "https://other.example/path",
    );
  });

  it("rejects an HTTPS-to-HTTP redirect downgrade by default", () => {
    const base = valid("https://example.com/start").url;
    expect(() =>
      parseRedirectTarget("http://example.com/plain", base, limits),
    ).toThrow(RedirectError);
    expect(() =>
      parseRedirectTarget("//example.com/plain", valid("http://example.com/start").url, limits),
    ).not.toThrow();
  });

  it("allows HTTP-to-HTTPS upgrades and HTTPS-to-HTTPS redirects", () => {
    const httpBase = valid("http://example.com/start").url;
    const httpsBase = valid("https://example.com/start").url;

    expect(
      parseRedirectTarget("https://example.com/secure", httpBase, limits)
        .canonical,
    ).toBe("https://example.com/secure");
    expect(
      parseRedirectTarget("https://other.example/secure", httpsBase, limits)
        .canonical,
    ).toBe("https://other.example/secure");
  });

  it("rejects unsafe redirect targets with the right class", () => {
    const base = valid("https://example.com/start").url;

    const privateRedirect = parseRedirectTarget(
      "https://127.0.0.1/",
      base,
      limits,
    );
    expect(privateRedirect.isIpLiteral).toBe(true);
    expect(privateRedirect.ipLiteral?.address).toBe("127.0.0.1");
    expect(() => parseRedirectTarget("http://localhost/", base, limits)).toThrow(
      UnsafeTargetError,
    );
    expect(() => parseRedirectTarget("ftp://example.com/", base, limits)).toThrow(
      RedirectError,
    );
    expect(() =>
      parseRedirectTarget("http://user:pass@example.com/", base, limits),
    ).toThrow(RedirectError);
    expect(() =>
      parseRedirectTarget("https://example.com:8443/", base, limits),
    ).toThrow(RedirectError);
    expect(() => parseRedirectTarget("", base, limits)).toThrow(RedirectError);
    expect(() => parseRedirectTarget(null, base, limits)).toThrow(RedirectError);
    expect(() =>
      parseRedirectTarget("https://example.com\\@127.0.0.1/", base, limits),
    ).toThrow(RedirectError);
  });
});
