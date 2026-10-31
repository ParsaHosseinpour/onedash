import { describe, expect, it } from "vitest";
import {
  isPublicIpAddress,
  parseIpAddress,
  publicAddressPolicy,
} from "../../worker/checker/ip-policy";

describe("IP address policy", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
  ])("allows public unicast address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
    expect(publicAddressPolicy(address)).toBe(true);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback range", "127.255.255.254"],
    ["private 10/8", "10.0.0.1"],
    ["private 172.16/12", "172.16.0.1"],
    ["private 192.168/16", "192.168.1.1"],
    ["link-local metadata", "169.254.169.254"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["unspecified", "0.0.0.0"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
    ["documentation", "192.0.2.1"],
    ["documentation 2", "198.51.100.1"],
    ["documentation 3", "203.0.113.1"],
    ["benchmarking", "198.18.0.1"],
    ["as112", "192.31.196.1"],
    ["ipv6 loopback", "::1"],
    ["ipv6 unspecified", "::"],
    ["ipv6 reserved ::/8", "::1:0:0"],
    ["ipv6 reserved 1::/8", "1::1"],
    ["ipv6 reserved 4000::/3", "4000::1"],
    ["ipv6 reserved 8000::/3", "8000::1"],
    ["unique local", "fc00::1"],
    ["aws ipv6 metadata", "fd00:ec2::254"],
    ["link local", "fe80::1"],
    ["multicast", "ff02::1"],
    ["documentation", "2001:db8::1"],
    ["ipv4-mapped loopback", "::ffff:127.0.0.1"],
    ["ipv4-mapped private", "::ffff:10.0.0.1"],
    ["ipv4-compatible loopback", "::7f00:1"],
    ["ipv4-compatible public", "::808:808"],
    ["ipv4-compatible dotted", "::8.8.8.8"],
    ["nat64 private", "64:ff9b::7f00:1"],
    ["6to4 private", "2002:7f00:1::"],
    ["teredo", "2001::1"],
    ["orchid2", "2001:20::1"],
    ["zone-scoped", "fe80::1%eth0"],
    ["malformed", "not-an-ip"],
  ])("blocks %s (%s)", (_label, address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it("normalizes parsed addresses", () => {
    expect(parseIpAddress("::FFFF:7F00:1")).toEqual({
      address: "::ffff:7f00:1",
      family: 6,
    });
    expect(parseIpAddress("2001:0db8:0000:0000:0000:0000:0000:0001")).toEqual({
      address: "2001:db8::1",
      family: 6,
    });
    expect(parseIpAddress("8.8.8.8")).toEqual({
      address: "8.8.8.8",
      family: 4,
    });
    expect(parseIpAddress("fe80::1%eth0")).toBeNull();
    expect(parseIpAddress("::8.8.8.8")).toBeNull();
    expect(parseIpAddress("")).toBeNull();
  });
});
