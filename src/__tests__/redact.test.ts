import { describe, expect, it } from "vitest";

import { redactEnv, redactSensitive, REDACTION_MASK } from "../redact.js";

describe("redactSensitive", () => {
  it("returns empty input untouched", () => {
    expect(redactSensitive("")).toBe("");
  });

  it("masks Bearer tokens but keeps the prefix", () => {
    const out = redactSensitive("Authorization: Bearer abc123def456ghijklmnop");
    expect(out).toBe(`Authorization: Bearer ${REDACTION_MASK}`);
    expect(out).not.toContain("abc123def456ghijklmnop");
  });

  it("masks access_token and refresh_token JSON-style payloads", () => {
    const out = redactSensitive('{"access_token":"abcdef1234","refresh_token":"zyxwvut987654"}');
    expect(out).not.toContain("abcdef1234");
    expect(out).not.toContain("zyxwvut987654");
    expect(out).toContain(`"access_token":"${REDACTION_MASK}"`);
    expect(out).toContain(`"refresh_token":"${REDACTION_MASK}"`);
  });

  it("masks Meta AI cookie pairs (datr/ecto_1_sess/abra_sess)", () => {
    const out = redactSensitive(
      "Cookie: datr=AAA-bbb-ccc-ddd; ecto_1_sess=session-token-xyz; abra_sess=secondary-token",
    );
    expect(out).not.toContain("AAA-bbb-ccc-ddd");
    expect(out).not.toContain("session-token-xyz");
    expect(out).not.toContain("secondary-token");
    expect(out).toMatch(new RegExp(`datr=${REDACTION_MASK.replace(/[[\]]/g, "\\$&")}`));
    expect(out).toMatch(new RegExp(`ecto_1_sess=${REDACTION_MASK.replace(/[[\]]/g, "\\$&")}`));
    expect(out).toMatch(new RegExp(`abra_sess=${REDACTION_MASK.replace(/[[\]]/g, "\\$&")}`));
  });

  it("preserves non-sensitive content", () => {
    const out = redactSensitive("metaai sidecar: starting (host=127.0.0.1 port=8742)");
    expect(out).toBe("metaai sidecar: starting (host=127.0.0.1 port=8742)");
  });

  it("masks fb_dtsg-style anti-CSRF tokens", () => {
    const out = redactSensitive('{"fb_dtsg":"NAcOkLzYy123:38:1234567890"}');
    expect(out).not.toContain("NAcOkLzYy123:38:1234567890");
    expect(out).toContain(`"fb_dtsg":"${REDACTION_MASK}"`);
  });
});

describe("redactEnv", () => {
  it("masks any env name starting with META_AI_", () => {
    const out = redactEnv({
      META_AI_DATR: "secret-cookie",
      META_AI_ECTO_1_SESS: "session-cookie",
      META_AI_ABRA_SESS: "secondary",
      OTHER: "ok",
    });
    expect(out.META_AI_DATR).toBe(REDACTION_MASK);
    expect(out.META_AI_ECTO_1_SESS).toBe(REDACTION_MASK);
    expect(out.META_AI_ABRA_SESS).toBe(REDACTION_MASK);
    expect(out.OTHER).toBe("ok");
  });

  it("masks _TOKEN/_SECRET/_KEY/COOKIE/PASSWORD suffixes", () => {
    const out = redactEnv({
      MY_TOKEN: "x",
      MY_SECRET: "x",
      MY_KEY: "x",
      MY_COOKIE: "x",
      MY_PASSWORD: "x",
      OK_VAR: "x",
    });
    expect(out.MY_TOKEN).toBe(REDACTION_MASK);
    expect(out.MY_SECRET).toBe(REDACTION_MASK);
    expect(out.MY_KEY).toBe(REDACTION_MASK);
    expect(out.MY_COOKIE).toBe(REDACTION_MASK);
    expect(out.MY_PASSWORD).toBe(REDACTION_MASK);
    expect(out.OK_VAR).toBe("x");
  });

  it("ignores undefined values", () => {
    const out = redactEnv({ META_AI_DATR: undefined, KEEP: "yes" });
    expect("META_AI_DATR" in out).toBe(false);
    expect(out.KEEP).toBe("yes");
  });
});
