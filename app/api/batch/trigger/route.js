import { NextResponse } from "next/server";
import { getSessionEmail } from "../../../../auth";

export async function POST(req) {
  const userEmail = await getSessionEmail();
  if (!userEmail) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const body = await req.json();
  // Never trust the client for who this batch is attributed to — same
  // principle POST /api/save-run and POST /api/scenarios already follow.
  const forwardedBody = { ...body, runAuthorEmail: userEmail };

  const url = process.env.BATCH_TRIGGER_URL;
  const secret = process.env.BATCH_TRIGGER_SHARED_SECRET;
  if (!url || !secret) {
    return NextResponse.json({ error: "BATCH_TRIGGER_URL/BATCH_TRIGGER_SHARED_SECRET not configured" }, { status: 500 });
  }

  // An unreachable proxy (DNS failure, cold-start timeout, ...) makes this
  // fetch throw. Unguarded, Next renders its default HTML error page, and the
  // browser's res.json() then fails on the HTML rather than showing why —
  // so return the same shape of JSON error the proxy itself returns.
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(forwardedBody),
    });
  } catch (err) {
    return NextResponse.json({ error: `batch trigger proxy unreachable: ${err.message}` }, { status: 502 });
  }

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
