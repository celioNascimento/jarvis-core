import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export async function GET() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Tenta uma leitura simples na tabela brain
  const { data, error } = await supabase
    .from('brain')
    .select('count')
    .limit(1);

  if (error) {
    return NextResponse.json({ 
      status: "❌ Erro de Conexão", 
      details: error.message,
      hint: error.hint 
    }, { status: 401 });
  }

  return NextResponse.json({ 
    status: "✅ Supabase Conectado!", 
    message: "A comunicação entre Vercel e Banco está funcionando.",
    data 
  });
}