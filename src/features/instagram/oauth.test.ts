// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { redirectToAuthorize, saveOauthState, takeOauthState } from "./oauth";

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe("oauth state", () => {
  it("guarda e lê uma vez só", () => {
    expect(saveOauthState("S")).toBe(true);
    expect(takeOauthState()).toBe("S");
    expect(takeOauthState()).toBeNull();
  });
  it("storage que lança não propaga", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("x"); });
    expect(saveOauthState("S")).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("x"); });
    expect(takeOauthState()).toBeNull();
  });
  it("redirectToAuthorize recusa o que não é https", () => {
    for (const url of ["http://a.com", "javascript:alert(1)", "//a.com", "data:text/html,x", ""]) {
      expect(redirectToAuthorize(url)).toBe(false);
    }
  });
});
