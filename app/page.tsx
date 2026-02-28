import { createClient } from '@supabase/supabase-js';

// Forçamos a página a ser dinâmica para ver os dados em tempo real
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'jarvis' } }
  );

  // Busca os últimos 5 registros do Jarvis
  const { data: logs } = await supabase
    .from('brain')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-8 font-sans">
      <header className="max-w-4xl mx-auto mb-12 border-b border-slate-800 pb-6">
        <h1 className="text-3xl font-bold tracking-tighter text-blue-400">JARVIS <span className="text-slate-500 text-sm font-mono">v1.0</span></h1>
        <p className="text-slate-400 mt-2">Sistema de Inteligência e Registro - Celio</p>
      </header>

      <section className="max-w-4xl mx-auto grid gap-6">
        <div className="bg-slate-900 border border-slate-800 p-6 rounded-lg shadow-xl">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
            Últimas Entradas do Cérebro
          </h2>
          
          <div className="space-y-4">
            {logs?.map((log) => (
              <div key={log.id} className="border-l-2 border-blue-500 pl-4 py-2 bg-slate-800/30 rounded-r">
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>{log.category} | {log.project_tag}</span>
                  <span>{new Date(log.created_at).toLocaleString('pt-BR')}</span>
                </div>
                <p className="text-sm text-slate-200">{log.content}</p>
                {log.metadata?.ai_reply && (
                  <p className="text-xs text-blue-300 mt-2 italic italic">
                    🤖 Jarvis: {log.metadata.ai_reply.substring(0, 100)}...
                  </p>
                )}
              </div>
            ))}
            {!logs?.length && <p className="text-slate-500 italic">Nenhum registro encontrado ainda.</p>}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg">
            <h3 className="text-sm font-bold text-slate-500 uppercase">Status do Webhook</h3>
            <p className="text-green-400 font-mono mt-1">OPERACIONAL /api/webhook</p>
          </div>
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg">
            <h3 className="text-sm font-bold text-slate-500 uppercase">Motor de IA</h3>
            <p className="text-blue-400 font-mono mt-1">OpenRouter / Gemini 2.0</p>
          </div>
        </div>
      </section>
    </main>
  );
}