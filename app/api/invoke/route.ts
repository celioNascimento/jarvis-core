import { NextRequest, NextResponse } from 'next/server';
import { callOpenRouter } from '@/lib/jarvis';

export async function POST(req: NextRequest) {
  try {
    const { system, message, model = 'flash' } = await req.json();

    if (!message) {
      return NextResponse.json({ error: 'message obrigatório' }, { status: 400 });
    }

    const messages = [];
    if (system) messages.push({ role: 'system' as const, content: system });
    messages.push({ role: 'user' as const, content: message });

    const text = await callOpenRouter(messages, model);
    return NextResponse.json({ text });
  } catch (e: any) {
    console.error('[invoke] Erro:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}