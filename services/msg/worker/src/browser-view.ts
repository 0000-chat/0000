export type BrowserView = "agent" | "human";

const VIEW_COOKIE = "msg_view";

export function selectBrowserView(url: URL, cookieHeader: string | null): BrowserView {
  const explicit = url.searchParams.get("view");
  if (explicit === "agent" || explicit === "human") return explicit;

  const saved = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${VIEW_COOKIE}=`))
    ?.slice(VIEW_COOKIE.length + 1);
  return saved === "agent" || saved === "human" ? saved : "agent";
}

export function viewSwitchHref(url: URL, target: BrowserView): string {
  const next = new URL(url);
  next.searchParams.delete("view");
  const destination = `${next.pathname}${next.search}${next.hash}`;
  return `/_msg/view/${target}?next=${encodeURIComponent(destination)}`;
}

export function browserViewRedirect(url: URL): Response | undefined {
  const match = /^\/_msg\/view\/(agent|human)$/u.exec(url.pathname);
  const next = url.searchParams.get("next");
  if (!match || !next?.startsWith("/")) return undefined;
  const destination = new URL(next, url);
  if (destination.origin !== url.origin) return undefined;
  return new Response(null, {
    status: 303,
    headers: {
      location: `${destination.pathname}${destination.search}${destination.hash}`,
      "set-cookie": `msg_view=${match[1]}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    },
  });
}
