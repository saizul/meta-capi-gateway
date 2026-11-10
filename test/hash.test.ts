import { describe, expect, it } from "vitest";
import { hashNormalized, isSha256Hex, sha256 } from "../src/hash.js";

describe("sha256 known vectors", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["hello", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"],
    ["The quick brown fox jumps over the lazy dog", "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"],
    ["john_smith@gmail.com", "62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f"],
    ["test@example.com", "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b"],
    ["8801712345678", "c327520f85b0c6058fed05dfc0a63d8755f325b6ea1b550824f4a8e380d75de1"],
    ["16505551212", "e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176"],
    ["dhaka", "de90643718108ec9a93cc6905f2b976297505a8abeac37b747132877fb32fb8d"],
    ["bd", "5e657ff6158d3e2a6d23e2a523917a2305acee9423365e268695c4b7b8919f4c"],
  ])("sha256(%j)", (input, expected) => {
    expect(sha256(input)).toBe(expected);
  });
});

describe("isSha256Hex / hashNormalized", () => {
  const h = sha256("abc");
  it("detects hex digests", () => {
    expect(isSha256Hex(h)).toBe(true);
    expect(isSha256Hex(h.toUpperCase())).toBe(true);
  });
  it("rejects other strings", () => {
    expect(isSha256Hex("abc")).toBe(false);
    expect(isSha256Hex(h + "0")).toBe(false);
    expect(isSha256Hex("z".repeat(64))).toBe(false);
  });
  it("does not double hash", () => {
    expect(hashNormalized(h)).toBe(h);
    expect(hashNormalized(h.toUpperCase())).toBe(h);
  });
  it("hashes plain values", () => {
    expect(hashNormalized("abc")).toBe(h);
  });
});
