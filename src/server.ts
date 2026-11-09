/**
 * Where the server lives. Entered on first start and kept on the device;
 * everything else (decks, cards, schedules) lives on the server.
 */

const KEY = "flashcards.serverUrl";

export function getServerUrl(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setServerUrl(url: string | null): void {
  try {
    if (url) localStorage.setItem(KEY, url);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: the setup screen will simply show again.
  }
}

/**
 * Accepts what people type ("myhost.tail1234.ts.net", "https://host/",
 * "https://host/api") and turns it into the server's base URL. Without a
 * scheme, https is assumed, which is what `tailscale serve` provides.
 */
export function normaliseServerUrl(input: string): string {
  let url = input.trim();
  if (!url) throw new Error("enter the server's address");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("that is not a valid address");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("the address must start with https://");
  }
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${parsed.origin}${path}`;
}

export interface Health {
  ok: boolean;
  app: string;
  version: string;
  /** True when the server holds no decks, categories or prompts yet. */
  empty: boolean;
}

/** Checks that a flashcards server answers at `baseUrl`. */
export async function checkServer(baseUrl: string): Promise<Health> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error(
      `Can't reach ${baseUrl}. Check the address, that the server is running, and that this device is connected to Tailscale.`,
    );
  }
  let body: Partial<Health> | null = null;
  try {
    body = await res.json();
  } catch {
    // handled below
  }
  if (!res.ok || !body || body.app !== "flashcards") {
    throw new Error(`${baseUrl} answered, but it is not a flashcards server.`);
  }
  return body as Health;
}
