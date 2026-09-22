import { describe, expect, test } from "bun:test";
import { browserViewRedirect, selectBrowserView, viewSwitchHref } from "./browser-view";

describe("browser view preference", () => {
  test("uses explicit query before a saved cookie", () => {
    expect(selectBrowserView(new URL("https://msg.0000.chat/?view=human"), "msg_view=agent")).toBe("human");
    expect(selectBrowserView(new URL("https://msg.0000.chat/?view=agent"), "msg_view=human")).toBe("agent");
  });

  test("uses a valid cookie and otherwise defaults to human", () => {
    expect(selectBrowserView(new URL("https://msg.0000.chat/"), "a=1; msg_view=human; b=2")).toBe("human");
    expect(selectBrowserView(new URL("https://msg.0000.chat/"), "msg_view=robot")).toBe("human");
    expect(selectBrowserView(new URL("https://msg.0000.chat/?view=robot"), null)).toBe("human");
    expect(selectBrowserView(new URL("https://msg.0000.chat/"), null)).toBe("human");
  });

  test("builds a deterministic fallback link without losing other query fields", () => {
    expect(viewSwitchHref(new URL("https://msg.0000.chat/room?after=3&view=agent"), "human")).toBe("/_msg/view/human?next=%2Froom%3Fafter%3D3");
  });

  test("stores a secure non-sensitive preference with a same-origin redirect", () => {
    const response = browserViewRedirect(new URL("https://msg.0000.chat/_msg/view/human?next=%2Froom%3Fafter%3D3"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/room?after=3");
    expect(response.headers.get("set-cookie")).toBe("msg_view=human; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
    expect(browserViewRedirect(new URL("https://msg.0000.chat/_msg/view/human?next=https://evil.test/"))).toBeUndefined();
    expect(browserViewRedirect(new URL("https://msg.0000.chat/_msg/view/human?next=%2F%5Cevil.test%2F"))).toBeUndefined();
  });
});
