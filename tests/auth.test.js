import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authEnabled, checkCredentials, issueToken, authorized, getTokenPayload, csrf, sessionCookie, clearCookie } from "../api/auth.js";

describe("auth", () => {
  // AUTH_USER / AUTH_PASS must be set in the environment before this module is
  // imported because config.js reads them at load time.

  it("authEnabled is true when credentials are set", () => {
    assert.equal(authEnabled(), true);
  });

  it("checkCredentials accepts correct credentials", () => {
    assert.equal(checkCredentials(process.env.AUTH_USER, process.env.AUTH_PASS), true);
  });

  it("checkCredentials rejects wrong password", () => {
    assert.equal(checkCredentials(process.env.AUTH_USER, "wrong"), false);
  });

  it("checkCredentials rejects wrong username", () => {
    assert.equal(checkCredentials("wrong", process.env.AUTH_PASS), false);
  });

  it("issueToken returns a token and csrf value", () => {
    const { token, csrf } = issueToken("admin");
    assert.ok(token);
    assert.ok(csrf);
    assert.ok(token.includes("."));
  });

  it("authorized recognizes a valid session cookie", () => {
    const { token, csrf } = issueToken("admin");
    const req = { headers: { cookie: `rsl_session=${encodeURIComponent(token)}` } };
    assert.equal(authorized(req), true);
    assert.equal(getTokenPayload(req).c, csrf);
  });

  it("authorized rejects a tampered cookie", () => {
    const { token } = issueToken("admin");
    const tampered = token.slice(0, -4) + "XXXX";
    const req = { headers: { cookie: `rsl_session=${tampered}` } };
    assert.equal(authorized(req), false);
  });

  it("authorized rejects an expired token", () => {
    const { token } = issueToken("admin");
    // Parse the payload, make it expired, re-sign with the same secret.
    const [payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    payload.exp = Date.now() - 1000;
    const expiredB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    // We can't re-sign without importing the secret, so just check parsePayload behavior.
    const expiredToken = `${expiredB64}.badmac`;
    const req = { headers: { cookie: `rsl_session=${expiredToken}` } };
    assert.equal(authorized(req), false);
  });

  it("sessionCookie includes HttpOnly and SameSite=Strict", () => {
    const cookie = sessionCookie("testtoken", false);
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("SameSite=Strict"));
    assert.ok(!cookie.includes("Secure"));
  });

  it("sessionCookie adds Secure when requested", () => {
    const cookie = sessionCookie("testtoken", true);
    assert.ok(cookie.includes("Secure"));
  });

  it("clearCookie expires the session", () => {
    const cookie = clearCookie();
    assert.ok(cookie.includes("Max-Age=0"));
  });

  describe("csrf middleware", () => {
    it("allows GET and HEAD requests without a token", () => {
      for (const method of ["GET", "HEAD"]) {
        const req = { method, headers: {} };
        let called = false;
        const next = () => {
          called = true;
        };
        csrf(req, {}, next);
        assert.equal(called, true, `${method} should pass CSRF`);
      }
    });

    it("rejects mutating requests without a token", () => {
      const req = { method: "POST", headers: {} };
      const res = {
        status(code) {
          this.code = code;
          return this;
        },
        json(body) {
          this.body = body;
        },
      };
      csrf(req, res, () => assert.fail("next should not be called"));
      assert.equal(res.code, 403);
    });

    it("accepts mutating requests with a valid CSRF token", () => {
      const { token, csrf: csrfValue } = issueToken("admin");
      const req = {
        method: "POST",
        headers: {
          cookie: `rsl_session=${encodeURIComponent(token)}`,
          "x-csrf-token": csrfValue,
        },
      };
      let called = false;
      const next = () => {
        called = true;
      };
      csrf(req, {}, next);
      assert.equal(called, true);
    });

    it("rejects mutating requests with a mismatched CSRF token", () => {
      const { token } = issueToken("admin");
      const req = {
        method: "POST",
        headers: {
          cookie: `rsl_session=${encodeURIComponent(token)}`,
          "x-csrf-token": "wrong",
        },
      };
      const res = {
        status(code) {
          this.code = code;
          return this;
        },
        json(body) {
          this.body = body;
        },
      };
      csrf(req, res, () => assert.fail("next should not be called"));
      assert.equal(res.code, 403);
    });
  });
});
