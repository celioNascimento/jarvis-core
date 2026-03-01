import { createClient } from '@supabase/supabase-js';

// Forçamos a página a ser dinâmica para ver os dados em tempo real sempre que atualizar
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'jarvis' } }
  );

  // Busca os últimos 5 registros do Jarvis (Memória de Longo Prazo recente)
  const { data: logs } = await supabase
    .from('brain')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-8 font-sans">
      {/* Header Estilo Dashboard */}
      <header className="max-w-4xl mx-auto mb-12 border-b border-slate-800 pb-6">
        <h1 className="text-3xl font-bold tracking-tighter text-blue-400">
          JARVIS <span className="text-slate-500 text-sm font-mono">v1.0</span>
        </h1>
        <p className="text-slate-400 mt-2">Sistema de Inteligência e Registro - Celio</p>
      </header>

      <section className="max-w-4xl mx-auto grid gap-6">
        {/* Painel Central: Logs do Cérebro */}
        <div className="bg-slate-900 border border-slate-800 p-6 rounded-lg shadow-xl">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
            Últimas Entradas do Cérebro
          </h2>
          
          <div className="space-y-4">
            {logs?.map((log) => (
              <div key={log.id} className="border-l-2 border-blue-500 pl-4 py-2 bg-slate-800/30 rounded-r hover:bg-slate-800/50 transition-colors">
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span className="font-mono uppercase">
                    {log.category} {log.project_tag ? `| #${log.project_tag}` : ''}
                  </span>
                  <span>{new Date(log.created_at).toLocaleString('pt-BR')}</span>
                </div>
                <p className="text-sm text-slate-200 leading-relaxed">{log.content}</p>
                
                {log.metadata?.ai_reply && (
                  <div className="mt-3 p-2 bg-blue-900/10 rounded border border-blue-900/20">
                    <p className="text-xs text-blue-300 italic">
                      🤖 <span className="font-bold not-italic">Jarvis:</span> {log.metadata.ai_reply.substring(0, 150)}...
                    </p>
                  </div>
                )}
              </div>
            ))}
            
            {!logs?.length && (
              <div className="text-center py-10">
                <p className="text-slate-500 italic">O cérebro está em repouso. Nenhum registro encontrado.</p>
              </div>
            )}
          </div>
        </div>

        {/* Status Cards - Feedback do Sistema */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg group hover:border-blue-500/50 transition-colors">
            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Status do Webhook</h3>
            <p className="text-green-400 font-mono mt-1 flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500 rounded-full"></span>
              OPERACIONAL /api/webhook
            </p>
          </div>
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg group hover:border-blue-500/50 transition-colors">
            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Motor de IA</h3>
            <p className="text-blue-400 font-mono mt-1">Gemini 2.0 Flash / OpenRouter</p>
          </div>
        </div>
      </section>

      {/* Footer Minimalista */}
      <footer className="max-w-4xl mx-auto mt-12 text-center text-slate-600 text-xs">
        <p>Londrina, PR • {new Date().getFullYear()}</p>
      </footer>
    </main>
  );
}