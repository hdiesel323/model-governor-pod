// Governor access gate (factory-hub#78). Mirrors factory-hub src/auth.ts.
//   - GET /health: open.
//   - Everything else: Authorization Bearer <FACTORY_HUB_TOKEN> (pods, runners, CLIs), or HTTP Basic with
//     password = FACTORY_HUB_TOKEN (operator browser).
//   - Admin routes (approve a paid model, set/trigger discovery and probes): Bearer <GOVERNOR_ADMIN_TOKEN> only.
//     Pods share FACTORY_HUB_TOKEN, so a pod must never be able to approve spend (ruling #1).
// Fails closed: without FACTORY_HUB_TOKEN only /health is served; without GOVERNOR_ADMIN_TOKEN no admin route is.

export interface GovAuthEnv {
  FACTORY_HUB_TOKEN?: string;
  GOVERNOR_ADMIN_TOKEN?: string;
}

const encoder = new TextEncoder();

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export function presentedSecret(header: string | null): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(/\s+/, 2);
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() === "bearer") return value;
  if (scheme.toLowerCase() === "basic") {
    try {
      const decoded = atob(value);
      const idx = decoded.indexOf(":");
      return idx >= 0 ? decoded.slice(idx + 1) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function isAdminRoute(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return /^\/api\/models\/[^/]+\/(approve|revoke)$/.test(pathname) || pathname.startsWith("/api/governor/");
}

/** Returns a rejection Response, or null if the request may proceed. */
export function authGate(request: Request, env: GovAuthEnv): Response | null {
  const url = new URL(request.url);
  if (url.pathname === "/health") return null;
  const secret = presentedSecret(request.headers.get("Authorization"));
  if (isAdminRoute(request.method, url.pathname)) {
    if (env.GOVERNOR_ADMIN_TOKEN && secret !== null && timingSafeEqual(secret, env.GOVERNOR_ADMIN_TOKEN)) return null;
    return new Response(JSON.stringify({ error: "admin credential required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (env.FACTORY_HUB_TOKEN && secret !== null && timingSafeEqual(secret, env.FACTORY_HUB_TOKEN)) return null;
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Basic realm="model-governor"' },
  });
}
