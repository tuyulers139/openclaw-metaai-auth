import { describe, expect, it } from "vitest";

import {
  ALL_COOKIE_ENV_VARS,
  buildSidecarCookieEnv,
  inspectCookieEnv,
  META_AI_ABRA_SESS,
  META_AI_DATR,
  META_AI_ECTO_1_SESS,
  readCookiesFromEnv,
  REQUIRED_COOKIE_ENV_VARS,
} from "../cookies.js";
import { MetaAiError } from "../errors.js";

describe("cookie env helpers", () => {
  it("exposes the canonical env-var names", () => {
    expect(REQUIRED_COOKIE_ENV_VARS).toEqual(["META_AI_DATR", "META_AI_ECTO_1_SESS"]);
    expect(ALL_COOKIE_ENV_VARS).toEqual([
      "META_AI_DATR",
      "META_AI_ECTO_1_SESS",
      "META_AI_ABRA_SESS",
    ]);
  });

  describe("inspectCookieEnv", () => {
    it("returns ready=false when required cookies are missing", () => {
      expect(inspectCookieEnv({})).toEqual({
        datr: false,
        ectoSess: false,
        abraSess: false,
        ready: false,
      });
    });

    it("treats whitespace-only values as missing", () => {
      const presence = inspectCookieEnv({
        [META_AI_DATR]: "   ",
        [META_AI_ECTO_1_SESS]: "session",
      });
      expect(presence.datr).toBe(false);
      expect(presence.ectoSess).toBe(true);
      expect(presence.ready).toBe(false);
    });

    it("returns ready=true when both required cookies are present", () => {
      const presence = inspectCookieEnv({
        [META_AI_DATR]: "datr-value",
        [META_AI_ECTO_1_SESS]: "ecto-value",
        [META_AI_ABRA_SESS]: "abra-value",
      });
      expect(presence).toEqual({
        datr: true,
        ectoSess: true,
        abraSess: true,
        ready: true,
      });
    });
  });

  describe("readCookiesFromEnv", () => {
    it("throws an auth error listing missing required cookies", () => {
      try {
        readCookiesFromEnv({});
        throw new Error("expected readCookiesFromEnv to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MetaAiError);
        const e = err as MetaAiError;
        expect(e.kind).toBe("auth");
        expect(e.details?.missing).toEqual([META_AI_DATR, META_AI_ECTO_1_SESS]);
      }
    });

    it("never echoes cookie values in thrown errors", () => {
      try {
        readCookiesFromEnv({ [META_AI_DATR]: "secret-value" });
      } catch (err) {
        expect((err as Error).message).not.toContain("secret-value");
      }
    });

    it("returns trimmed cookie values when configured", () => {
      const cookies = readCookiesFromEnv({
        [META_AI_DATR]: "  datr-value  ",
        [META_AI_ECTO_1_SESS]: "ecto-value",
        [META_AI_ABRA_SESS]: "abra-value",
      });
      expect(cookies).toEqual({
        datr: "datr-value",
        ectoSess: "ecto-value",
        abraSess: "abra-value",
      });
    });

    it("treats abra_sess as optional", () => {
      const cookies = readCookiesFromEnv({
        [META_AI_DATR]: "d",
        [META_AI_ECTO_1_SESS]: "e",
      });
      expect(cookies.abraSess).toBe("");
    });
  });

  describe("buildSidecarCookieEnv", () => {
    it("emits only required env keys when abra is absent", () => {
      const env = buildSidecarCookieEnv({ datr: "d", ectoSess: "e", abraSess: "" });
      expect(env).toEqual({ [META_AI_DATR]: "d", [META_AI_ECTO_1_SESS]: "e" });
    });

    it("emits all three keys when abra is present", () => {
      const env = buildSidecarCookieEnv({ datr: "d", ectoSess: "e", abraSess: "a" });
      expect(env).toEqual({
        [META_AI_DATR]: "d",
        [META_AI_ECTO_1_SESS]: "e",
        [META_AI_ABRA_SESS]: "a",
      });
    });
  });
});
