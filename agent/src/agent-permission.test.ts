import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SAFE_BASH_RE, NETWORK_BASH_RE } from "./bash-policy.js";

describe("SAFE_BASH_RE", () => {
  it("rejects a newline-injected command (cat x\\nnc evil.com 80)", () => {
    assert.ok(!SAFE_BASH_RE.test("cat x\nnc evil.com 80"), "newline injection must not pass as safe");
  });

  it("accepts a plain read-only command (cat foo.txt)", () => {
    assert.ok(SAFE_BASH_RE.test("cat foo.txt"), "plain cat should be safe");
  });

  it("rejects a command with a pipe", () => {
    assert.ok(!SAFE_BASH_RE.test("cat foo.txt | grep secret"), "pipes must not pass as safe");
  });

  it("rejects a command with a semicolon", () => {
    assert.ok(!SAFE_BASH_RE.test("ls; rm -rf /"), "semicolons must not pass as safe");
  });

  it("rejects a carriage-return injection", () => {
    assert.ok(!SAFE_BASH_RE.test("cat foo.txt\rnc evil.com 80"), "CR injection must not pass as safe");
  });

  it("accepts ls with a path argument", () => {
    assert.ok(SAFE_BASH_RE.test("ls /tmp/foo"), "ls with path should be safe");
  });
});

describe("NETWORK_BASH_RE", () => {
  it("matches python3 -c invocation", () => {
    assert.ok(NETWORK_BASH_RE.test('python3 -c "import socket; s=socket.create_connection((\'evil.com\',80))"'));
  });

  it("matches node -e invocation", () => {
    assert.ok(NETWORK_BASH_RE.test('node -e "require(\'http\').get(\'http://evil.com\')"'));
  });

  it("matches nc (netcat)", () => {
    assert.ok(NETWORK_BASH_RE.test("nc evil 80"), "nc should match");
  });

  it("matches curl", () => {
    assert.ok(NETWORK_BASH_RE.test("curl https://example.com"), "curl should match");
  });

  it("matches dig", () => {
    assert.ok(NETWORK_BASH_RE.test("dig evil.com"), "dig should match");
  });

  it("matches nslookup", () => {
    assert.ok(NETWORK_BASH_RE.test("nslookup evil.com"), "nslookup should match");
  });

  it("matches host", () => {
    assert.ok(NETWORK_BASH_RE.test("host evil.com"), "host should match");
  });

  it("matches socat", () => {
    assert.ok(NETWORK_BASH_RE.test("socat TCP:evil.com:80 -"), "socat should match");
  });

  it("matches python2-style python -m", () => {
    assert.ok(NETWORK_BASH_RE.test("python -m http.server 8080"), "python -m should match");
  });

  it("does not match a plain ls command", () => {
    assert.ok(!NETWORK_BASH_RE.test("ls /tmp"), "ls should not match as network");
  });
});
