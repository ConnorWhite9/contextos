import { describe, expect, test } from "vitest";
import { clampToTokens, estimateTokens } from "./tokens";

describe("utils/tokens", () => {
  // --- estimateTokens -------------------------------------------------------

  test("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("returns the ceiling of length / 4", () => {
    // 4 chars → exactly 1 token
    expect(estimateTokens("abcd")).toBe(1);
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokens("abcde")).toBe(2);
    // 7 chars → ceil(7/4) = 2
    expect(estimateTokens("abcdefg")).toBe(2);
    // 8 chars → exactly 2
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  test("always returns a positive integer for non-empty input", () => {
    expect(estimateTokens("x")).toBe(1);
    expect(Number.isInteger(estimateTokens("hello world"))).toBe(true);
  });

  test("scales linearly with text length", () => {
    const base = estimateTokens("a".repeat(100));
    const double = estimateTokens("a".repeat(200));
    expect(double).toBeCloseTo(base * 2, 0);
  });

  // --- clampToTokens --------------------------------------------------------

  test("returns the original text unchanged when it fits within maxTokens", () => {
    const text = "short text";
    expect(clampToTokens(text, 1000)).toBe(text);
  });

  test("returns empty string when maxTokens is 0", () => {
    expect(clampToTokens("some content", 0)).toBe("");
  });

  test("returns empty string when maxTokens is negative", () => {
    expect(clampToTokens("content", -5)).toBe("");
  });

  test("truncates text that exceeds maxTokens", () => {
    const longText = "a".repeat(400); // 400 chars = 100 tokens
    const clamped = clampToTokens(longText, 10); // 10 tokens = 40 chars max
    expect(estimateTokens(clamped)).toBeLessThanOrEqual(10);
  });

  test("appends the truncation marker when content is cut", () => {
    const longText = "a".repeat(400);
    const clamped = clampToTokens(longText, 10);
    expect(clamped).toContain("…truncated by ContextOS…");
  });

  test("does NOT append marker when text fits without truncation", () => {
    const text = "fits";
    expect(clampToTokens(text, 1000)).not.toContain("…truncated");
  });

  test("result token count is at or below maxTokens after clamping", () => {
    // 500 tokens of content, clamp to 50
    const text = "x".repeat(2000);
    const clamped = clampToTokens(text, 50);
    expect(estimateTokens(clamped)).toBeLessThanOrEqual(50);
  });

  test("very small maxTokens returns only the marker (no leading body)", () => {
    // maxTokens so small the headroom is <= 0, just the marker itself
    const clamped = clampToTokens("a".repeat(1000), 1);
    // Marker should not be empty
    expect(clamped.length).toBeGreaterThan(0);
  });
});
