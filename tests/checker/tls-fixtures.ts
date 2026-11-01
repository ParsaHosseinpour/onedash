import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

export const TEST_TLS_HOSTNAME = "checker.test";
export const TEST_TLS_WRONG_HOSTNAME = "wrong-host.test";

export type TestTlsFixtures = {
  directory: string;
  caCert: string;
  serverKey: string;
  serverCert: string;
  wrongHostKey: string;
  wrongHostCert: string;
  selfSignedKey: string;
  selfSignedCert: string;
  cleanup: () => void;
};

type TlsCaApi = typeof tls & {
  getCACertificates?: (type?: string) => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

/** True when the local OpenSSL CLI can generate disposable test certificates. */
export function canGenerateTestCertificates(): boolean {
  const result = spawnSync("openssl", ["version"], { stdio: "ignore" });
  return result.status === 0;
}

/** True when this Node runtime can add a test CA without disabling verification. */
export function canTrustTestCertificateAuthority(): boolean {
  const api = tls as TlsCaApi;
  return (
    typeof api.getCACertificates === "function" &&
    typeof api.setDefaultCACertificates === "function"
  );
}

function runOpenSsl(directory: string, args: string[]): void {
  execFileSync("openssl", args, {
    cwd: directory,
    stdio: "pipe",
  });
}

function leafConfig(commonName: string, selfSigned: boolean): string {
  return [
    "[req]",
    "prompt = no",
    "distinguished_name = dn",
    ...(selfSigned ? ["x509_extensions = v3_leaf"] : []),
    "",
    "[dn]",
    `CN = ${commonName}`,
    "",
    "[v3_leaf]",
    "basicConstraints = critical, CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "subjectAltName = @alt_names",
    "",
    "[alt_names]",
    `DNS.1 = ${commonName}`,
    "",
  ].join("\n");
}

function createCa(directory: string): { key: string; cert: string } {
  const key = join(directory, "ca-key.pem");
  const cert = join(directory, "ca-cert.pem");
  const config = join(directory, "ca.cnf");

  writeFileSync(
    config,
    [
      "[req]",
      "prompt = no",
      "distinguished_name = dn",
      "x509_extensions = v3_ca",
      "",
      "[dn]",
      "CN = OneDash Checker Test CA",
      "",
      "[v3_ca]",
      "basicConstraints = critical, CA:TRUE",
      "keyUsage = critical, keyCertSign, cRLSign",
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid:always,issuer",
      "",
    ].join("\n"),
  );

  runOpenSsl(directory, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "2",
    "-sha256",
    "-config",
    config,
  ]);

  return { key, cert };
}

function createSelfSignedLeaf(
  directory: string,
  commonName: string,
  prefix: string,
): { key: string; cert: string } {
  const key = join(directory, `${prefix}-key.pem`);
  const cert = join(directory, `${prefix}-cert.pem`);
  const config = join(directory, `${prefix}.cnf`);

  writeFileSync(config, leafConfig(commonName, true));

  runOpenSsl(directory, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "2",
    "-sha256",
    "-config",
    config,
  ]);

  return { key, cert };
}

function createCaSignedLeaf(
  directory: string,
  commonName: string,
  prefix: string,
  ca: { key: string; cert: string },
  firstLeaf: boolean,
): { key: string; cert: string } {
  const key = join(directory, `${prefix}-key.pem`);
  const cert = join(directory, `${prefix}-cert.pem`);
  const csr = join(directory, `${prefix}.csr`);
  const config = join(directory, `${prefix}.cnf`);
  const serial = join(directory, "ca-cert.srl");

  writeFileSync(config, leafConfig(commonName, false));

  runOpenSsl(directory, [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-config",
    config,
  ]);

  runOpenSsl(directory, [
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca.cert,
    "-CAkey",
    ca.key,
    ...(firstLeaf ? ["-CAcreateserial"] : ["-CAserial", serial]),
    "-out",
    cert,
    "-days",
    "2",
    "-sha256",
    "-extfile",
    config,
    "-extensions",
    "v3_leaf",
  ]);

  return { key, cert };
}

/**
 * Generates disposable CA and leaf certificates for the current test run. The
 * private keys exist only in an OS temporary directory and are removed by
 * cleanup(); no key or certificate is committed to the repository.
 */
export function createTestTlsFixtures(): TestTlsFixtures {
  const directory = mkdtempSync(join(tmpdir(), "onedash-checker-tls-"));
  const ca = createCa(directory);
  const server = createCaSignedLeaf(
    directory,
    TEST_TLS_HOSTNAME,
    "server",
    ca,
    true,
  );
  const wrongHost = createCaSignedLeaf(
    directory,
    TEST_TLS_WRONG_HOSTNAME,
    "wrong-host",
    ca,
    false,
  );
  const selfSigned = createSelfSignedLeaf(
    directory,
    TEST_TLS_HOSTNAME,
    "self-signed",
  );

  return {
    directory,
    caCert: readFileSync(ca.cert, "utf8"),
    serverKey: readFileSync(server.key, "utf8"),
    serverCert: readFileSync(server.cert, "utf8"),
    wrongHostKey: readFileSync(wrongHost.key, "utf8"),
    wrongHostCert: readFileSync(wrongHost.cert, "utf8"),
    selfSignedKey: readFileSync(selfSigned.key, "utf8"),
    selfSignedCert: readFileSync(selfSigned.cert, "utf8"),
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Adds the generated test CA to Node's default trust store for this test
 * process. TLS certificate verification remains enabled; only the test CA is
 * added. Returns a function that restores the previous trust store.
 */
export function trustTestCertificateAuthority(caCert: string): () => void {
  const api = tls as TlsCaApi;
  if (
    typeof api.getCACertificates !== "function" ||
    typeof api.setDefaultCACertificates !== "function"
  ) {
    throw new Error(
      "this Node runtime cannot add a test CA without disabling verification",
    );
  }

  const previous = api.getCACertificates("default");
  api.setDefaultCACertificates([...previous, caCert]);
  return () => api.setDefaultCACertificates?.(previous);
}
