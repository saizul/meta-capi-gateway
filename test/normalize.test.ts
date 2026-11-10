import { describe, expect, it } from "vitest";
import {
  buildUserData,
  cleanIp,
  isBangladeshMobile,
  normalizeCity,
  normalizeCountry,
  normalizeDob,
  normalizeEmail,
  normalizeExternalId,
  normalizeGender,
  normalizeName,
  normalizePhone,
  normalizeState,
  normalizeZip,
} from "../src/normalize.js";
import { sha256 } from "../src/hash.js";

describe("normalizeEmail", () => {
  it.each([
    ["  John_Smith@Gmail.com ", "john_smith@gmail.com"],
    ["TEST@EXAMPLE.COM", "test@example.com"],
    ["a+tag@sub.example.co.uk", "a+tag@sub.example.co.uk"],
  ])("%j -> %j", (i, o) => expect(normalizeEmail(i)).toBe(o));
  it.each(["", "   ", "nope", "a@b", "a b@c.com", "@x.com"])("rejects %j", (i) => {
    expect(normalizeEmail(i)).toBeUndefined();
  });
});

describe("normalizePhone (default Bangladesh 880)", () => {
  it.each([
    ["01712345678", "8801712345678"],
    ["01712-345678", "8801712345678"],
    ["017 1234 5678", "8801712345678"],
    ["+8801712345678", "8801712345678"],
    ["8801712345678", "8801712345678"],
    ["008801712345678", "8801712345678"],
    ["+880 1712-345678", "8801712345678"],
    ["+880 01712345678", "8801712345678"],
    ["1712345678", "8801712345678"],
    ["(880) 171-2345678", "8801712345678"],
    ["01912345678", "8801912345678"],
    ["01312345678", "8801312345678"],
    ["  +88 01812 345678 ", "8801812345678"],
  ])("BD %j -> %j", (i, o) => expect(normalizePhone(i)).toBe(o));

  it.each([
    ["+1 (650) 555-1212", "16505551212"],
    ["16505551212", "16505551212"],
    ["+44 7911 123456", "447911123456"],
    ["0044 7911 123456", "447911123456"],
    ["+91 98765 43210", "919876543210"],
  ])("international %j -> %j", (i, o) => expect(normalizePhone(i)).toBe(o));

  it("honours a different default country code", () => {
    expect(normalizePhone("07911123456", "44")).toBe("447911123456");
    expect(normalizePhone("9876543210", "91")).toBe("919876543210");
  });

  it.each(["", "   ", "abc", "+", "123", "1234567890123456789"])("rejects %j", (i) => {
    expect(normalizePhone(i)).toBeUndefined();
  });

  it("recognises Bangladesh mobile numbers", () => {
    expect(isBangladeshMobile("8801712345678")).toBe(true);
    expect(isBangladeshMobile("8801212345678")).toBe(false);
    expect(isBangladeshMobile("880171234567")).toBe(false);
    expect(isBangladeshMobile("16505551212")).toBe(false);
  });
});

describe("normalizeName / city / state", () => {
  it.each([
    ["  John ", "john"],
    ["Mary-Jane O'Neil", "maryjane oneil"],
    ["Md.  Saizul", "md saizul"],
    ["José", "josé"],
    ["সাইজুল", "সাইজুল"],
  ])("name %j -> %j", (i, o) => expect(normalizeName(i)).toBe(o));
  it("name empty -> undefined", () => {
    expect(normalizeName("  ..  ")).toBeUndefined();
  });
  it.each([
    ["Dhaka", "dhaka"],
    ["New York", "newyork"],
    ["St. Louis", "stlouis"],
    ["Cox's Bazar", "coxsbazar"],
  ])("city %j -> %j", (i, o) => expect(normalizeCity(i)).toBe(o));
  it("city empty -> undefined", () => expect(normalizeCity("123")).toBeUndefined());
  it.each([
    ["CA", "ca"],
    ["Dhaka Division", "dhakadivision"],
  ])("state %j -> %j", (i, o) => expect(normalizeState(i)).toBe(o));
});

describe("normalizeZip", () => {
  it.each([
    ["1212", undefined, "1212"],
    ["SW1A 1AA", undefined, "sw1a1aa"],
    ["94035-1234", "us", "94035"],
    ["94035-1234", "bd", "940351234"],
    ["  ", undefined, undefined],
  ])("%j (%j) -> %j", (z, c, o) => expect(normalizeZip(z, c)).toBe(o));
});

describe("normalizeCountry", () => {
  it.each([
    ["BD", "bd"],
    [" us ", "us"],
    ["Bangladesh", "bd"],
    ["United States", "us"],
    ["UK", "gb"],
  ])("%j -> %j", (i, o) => expect(normalizeCountry(i)).toBe(o));
  it.each(["", "B", "BGD", "Atlantis"])("rejects %j", (i) => expect(normalizeCountry(i)).toBeUndefined());
});

describe("misc normalizers", () => {
  it("external id is trimmed but case preserved", () => {
    expect(normalizeExternalId("  User_42 ")).toBe("User_42");
    expect(normalizeExternalId("  ")).toBeUndefined();
  });
  it.each([
    ["1990-05-17", "19900517"],
    ["1990/05/17", "19900517"],
    ["19900517", "19900517"],
  ])("dob %j", (i, o) => expect(normalizeDob(i)).toBe(o));
  it.each(["17-05-1990", "1990-13-01", "1990-00-10", "x"])("dob rejects %j", (i) => {
    expect(normalizeDob(i)).toBeUndefined();
  });
  it.each([
    ["Female", "f"],
    ["M", "m"],
    ["man", "m"],
    ["other", undefined],
  ])("gender %j", (i, o) => expect(normalizeGender(i)).toBe(o));
  it("cleanIp strips IPv4-mapped prefix", () => {
    expect(cleanIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(cleanIp("2001:db8::1")).toBe("2001:db8::1");
    expect(cleanIp(undefined)).toBeUndefined();
    expect(cleanIp("  ")).toBeUndefined();
  });
});

describe("buildUserData", () => {
  it("hashes normalized values and wraps them in arrays", () => {
    const u = buildUserData({
      email: " John_Smith@Gmail.com ",
      phone: "01712-345678",
      first_name: "John",
      last_name: "Smith",
      city: "Dhaka",
      country: "BD",
    });
    expect(u.em).toEqual(["62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f"]);
    expect(u.ph).toEqual(["c327520f85b0c6058fed05dfc0a63d8755f325b6ea1b550824f4a8e380d75de1"]);
    expect(u.fn).toEqual(["96d9632f363564cc3032521409cf22a852f2032eec099ed5967c0d000cec607a"]);
    expect(u.ln).toEqual(["6627835f988e2c5e50533d491163072d3f4f41f5c8b04630150debb3722ca2dd"]);
    expect(u.ct).toEqual(["de90643718108ec9a93cc6905f2b976297505a8abeac37b747132877fb32fb8d"]);
    expect(u.country).toEqual(["5e657ff6158d3e2a6d23e2a523917a2305acee9423365e268695c4b7b8919f4c"]);
  });
  it("passes ip, user agent, fbp and fbc through unhashed", () => {
    const u = buildUserData(
      { fbp: "fb.1.1700000000000.123456789", fbc: "fb.1.1700000000000.AbCd" },
      { ip: "::ffff:203.0.113.9", userAgent: "Mozilla/5.0" },
    );
    expect(u.client_ip_address).toBe("203.0.113.9");
    expect(u.client_user_agent).toBe("Mozilla/5.0");
    expect(u.fbp).toBe("fb.1.1700000000000.123456789");
    expect(u.fbc).toBe("fb.1.1700000000000.AbCd");
  });
  it("hashes external_id", () => {
    expect(buildUserData({ external_id: "1234" }).external_id).toEqual([sha256("1234")]);
  });
  it("does not double hash pre-hashed values", () => {
    const h = sha256("test@example.com");
    expect(buildUserData({ email: h.toUpperCase() }).em).toEqual([h]);
  });
  it("omits values that fail normalization", () => {
    const u = buildUserData({ email: "bad", phone: "12", country: "Atlantis" });
    expect(u.em).toBeUndefined();
    expect(u.ph).toBeUndefined();
    expect(u.country).toBeUndefined();
  });
  it("uses the configured default country code for phones", () => {
    expect(buildUserData({ phone: "07911123456" }, { defaultCountryCode: "44" }).ph).toEqual([sha256("447911123456")]);
  });
  it("zip normalization depends on country", () => {
    expect(buildUserData({ zip: "94035-1234", country: "US" }).zp).toEqual([sha256("94035")]);
  });
  it("never contains raw PII", () => {
    const u = buildUserData({ email: "a@b.com", phone: "01712345678", first_name: "Zed" });
    const text = JSON.stringify(u);
    expect(text).not.toContain("a@b.com");
    expect(text).not.toContain("01712345678");
    expect(text).not.toContain("zed");
  });
  it("empty input gives empty object", () => {
    expect(buildUserData({})).toEqual({});
  });
});
