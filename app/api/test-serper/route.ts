import { NextResponse } from 'next/server';
import { searchWeb } from '@/lib/google';

export async function GET() {
  const query = 'clima em Londrina';
  const result = await searchWeb(query);
  return NextResponse.json({ query, result });
}