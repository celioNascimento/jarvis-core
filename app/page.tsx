import { createClient } from '@supabase/supabase-js';
import LoginButton from '@/components/LoginButton'; // Certifique-se de que o arquivo existe em components/

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'jarvis' } }
  );

  // Busca os últimos registros do Cérebro
  const { data: logs } = await supabase
    .from('brain')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(8);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-8 font-sans">
      {/* HEADER CONSOLIDADO */}
      <header className="max-w-4xl mx-auto mb-12 border-b border-slate-800 pb-6 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tighter text-blue-400">
            JARVIS <span className="text-slate-500 text-sm font-mono">v1.0</span>
          </h1>
          <p className="text-slate-400 mt-2 font-light">Londrina, PR • Sistema de Inteligência e Registro</p>
        </div>
        
        {/* Botão de Acesso para sincronizar Gmail/Agenda */}
        <div className="flex flex-col items-end gap-2">
          <LoginButton />
          <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">Google Auth Level: Full Access</span>
        </div>
      </header>

      <section className="max-w-4xl mx-auto grid gap-6">
        
        {/* STATUS DO SISTEMA */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Status</h3>
            <p className="text-green-400 font-mono text-sm flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
              ONLINE
            </p>
          </div>
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Cérebro</h3>
            <p className="text-blue-400 font-mono text-sm">Gemini 2.0 Flash</p>
          </div>
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Localização</h3>
            <p className="text-slate-300 font-mono text-sm">Londrina, Brasil</p>
          </div>
        </div>

        {/* TIMELINE DE MEMÓRIA */}
        <div className="bg-slate-900 border border-slate-800 p-6 rounded-lg shadow-2xl">
          <h2 className="text-lg font-semibold mb-6 flex items-center gap-2 border-b border-slate-800 pb-2">
            Timeline de Contexto
          </h2>
          
          <div className="space-y-6">
            {logs?.map((log) => (
              <div key={log.id} className="relative pl-6 border-l border-slate-700 pb-2 group">
                {/* Ponto na timeline */}
                <div className="absolute -left-[5px] top-2 w-2 h-2 bg-slate-700 rounded-full group-hover:bg-blue-500 transition-colors"></div>
                
                <div className="flex justify-between text-[10px] text-slate-500 mb-2">
                  <span className="font-mono bg-slate-800 px-2 py-0.5 rounded text-blue-300">
                    {log.category} {log.project_tag ? `| #${log.project_tag}` : ''}
                  </span>
                  <span>{new Date(log.created_at).toLocaleString('pt-BR')}</span>
                </div>

                <p className="text-sm text-slate-300 leading-relaxed mb-3">{log.content}</p>
                
                {log.metadata?.ai_reply && (
                  <div className="p-3 bg-blue-950/20 rounded border border-blue-900/30">
                    <p className="text-sm text-blue-200/80 italic whitespace-pre-wrap">
                      <span className="font-bold not-italic text-blue-400">🤖 Jarvis:</span> {log.metadata.ai_reply}
                    </p>
                  </div>
                )}
              </div>
            ))}

            {!logs?.length && (
              <div className="text-center py-12">
                <p className="text-slate-600 italic font-light">Nenhum registro encontrado na memória de longo prazo.</p>
              </div>
            )}
          </div>
        </div>

      </section>

      <footer className="max-w-4xl mx-auto mt-16 text-center border-t border-slate-900 pt-8 text-slate-600 text-[10px] tracking-[0.2em] uppercase">
        Design por Jarvis Architecture • {new Date().getFullYear()}
      </footer>
    </main>
  );
}