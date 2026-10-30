import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DEFAULT_TIMEOUT_MS = 30000;

// POST { egressRotateUrl, egressRotateToken? } — fire one rotation against the
// configured sock2http endpoint so the user can see it work from the dashboard.
// Accepts the form values (untested input), falling back to stored settings.
// GET is disallowed: this burns the proxy's rotation cooldown on purpose.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  let url = String(body?.egressRotateUrl || "").trim();
  let token = String(body?.egressRotateToken || "").trim();

  if (!url || !token) {
    try {
      const { getSettings } = await import("@/lib/localDb");
      const settings = await getSettings();
      url = url || (settings.egressRotateUrl || "").trim();
      token = token || (settings.egressRotateToken || "").trim();
    } catch {
      // fall through with whatever was supplied
    }
  }

  if (!url) {
    return NextResponse.json({ ok: false, error: "no rotate URL configured" }, { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ ok: false, error: "rotate URL is not valid" }, { status: 400 });
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  if (!loopback) {
    return NextResponse.json(
      { ok: false, error: `rotate URL must be loopback (got ${host})` },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-Rotate-Token"] = token;
    const res = await fetch(parsed.toString(), {
      method: "POST",
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // non-JSON body
    }

    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ ok: false, rotateStatus: res.status, error: "rotation rejected: bad or missing token" }, { status: 200 });
    }
    if (res.status === 409) {
      return NextResponse.json({ ok: false, rotateStatus: 409, error: payload?.error || "rotation busy (cooldown or in-flight traffic)" }, { status: 200 });
    }
    if (!res.ok) {
      return NextResponse.json({ ok: false, rotateStatus: res.status, error: payload?.error || text.slice(0, 200) }, { status: 200 });
    }
    return NextResponse.json({
      ok: true,
      rotateStatus: res.status,
      oldIp: payload?.oldIp,
      newIp: payload?.newIp,
      ipChanged: payload?.verified === true,
      note: payload?.verified ? undefined : "proxy reports swap done; a new exit IP is not guaranteed for all transports",
    });
  } catch (err) {
    const reason = controller.signal.aborted ? `timed out after ${DEFAULT_TIMEOUT_MS / 1000}s` : err.message;
    return NextResponse.json({ ok: false, error: `rotation request failed: ${reason}` }, { status: 200 });
  } finally {
    clearTimeout(timer);
  }
}
