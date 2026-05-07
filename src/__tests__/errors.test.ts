import { describe, expect, it } from "vitest";

import {
  authError,
  configError,
  internalError,
  MetaAiError,
  rateLimited,
  sidecarTimeout,
  sidecarUnavailable,
  toMetaAiError,
  transportError,
  upstreamError,
} from "../errors.js";

describe("MetaAiError factories", () => {
  it("redacts cookie values in the resulting message", () => {
    const err = upstreamError(
      'metaai sidecar 500: "datr=BAD_VALUE_12345; ecto_1_sess=SESSION-XYZ"',
      500,
    );
    expect(err).toBeInstanceOf(MetaAiError);
    expect(err.kind).toBe("upstream");
    expect(err.status).toBe(500);
    expect(err.message).not.toContain("BAD_VALUE_12345");
    expect(err.message).not.toContain("SESSION-XYZ");
  });

  it("classifies retryable kinds", () => {
    expect(sidecarTimeout("t").isRetryable()).toBe(true);
    expect(rateLimited("r").isRetryable()).toBe(true);
    expect(transportError("x").isRetryable()).toBe(true);
    expect(authError("a").isRetryable()).toBe(false);
    expect(configError("c").isRetryable()).toBe(false);
    expect(upstreamError("u").isRetryable()).toBe(false);
    expect(internalError("i").isRetryable()).toBe(false);
    expect(sidecarUnavailable("s").isRetryable()).toBe(false);
  });
});

describe("toMetaAiError", () => {
  it("passes MetaAiError instances through unchanged", () => {
    const original = configError("config bad");
    expect(toMetaAiError(original)).toBe(original);
  });

  it("wraps Error instances with redacted messages", () => {
    const wrapped = toMetaAiError(new Error("Bearer abcdef1234567890 leaked"));
    expect(wrapped).toBeInstanceOf(MetaAiError);
    expect(wrapped.message).not.toContain("abcdef1234567890");
    expect(wrapped.kind).toBe("internal");
  });

  it("wraps non-Error values with stringified messages", () => {
    const wrapped = toMetaAiError({ weird: true });
    expect(wrapped.message).toBe("[object Object]");
    expect(wrapped.kind).toBe("internal");
  });

  it("respects the fallback kind when wrapping", () => {
    const wrapped = toMetaAiError("oops", "transport");
    expect(wrapped.kind).toBe("transport");
  });
});
