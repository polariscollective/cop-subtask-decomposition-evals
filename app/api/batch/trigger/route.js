import { NextResponse } from "next/server";

export async function POST(req) {
  const body = await req.json();

  const url = process.env.BATCH_TRIGGER_URL;
  const secret = process.env.BATCH_TRIGGER_SHARED_SECRET;
  if (!url || !secret) {
    return NextResponse.json({ error: "BATCH_TRIGGER_URL/BATCH_TRIGGER_SHARED_SECRET not configured" }, { status: 500 });
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
