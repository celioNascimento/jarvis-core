// app/api/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  return NextResponse.json({ ok: true, message: 'Webhook endpoint' });
}

export async function GET(req: NextRequest) {
  return NextResponse.json({ ok: true });
}