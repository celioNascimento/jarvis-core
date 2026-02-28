import { createClient } from '@supabase/supabase-js';

// Conexão com o Schema Jarvis
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export const dynamic = 'force-dynamic'; // Garante que as notas novas apareçam ao dar refresh

export default async function JarvisDashboard() {
  // Busca as últimas 10 notas do "Cérebro"
  const { data: notes, error } = await supabase
    .from('brain')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  return (
    <main style={{ padding: '2rem', fontFamily: 'sans-serif', backgroundColor: '#0f172a', color: '#f8fafc', minHeight: '100vh' }}>
      <header style={{ borderBottom: '1px solid #334155', paddingBottom: '1rem', marginBottom: '2rem' }}>
        <h1 style={{ color: '#38bdf8' }}>🛰️ Jarvis Core - Dashboard</h1>
        <p style={{ color: '#94a3b8' }}>Monitorando: Procuro Quem Faça & ExpertFrotas</p>
      </header>

      <section style={{ display: 'grid', gap: '1rem' }}>
        {notes?.map((note) => (
          <div key={note.id} style={{ backgroundColor: '#1e293b', padding: '1.5rem', borderRadius: '8px', borderLeft: '4px solid #38bdf8' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', color: '#7dd3fc', fontWeight: 'bold' }}>[{note.category}]</span>
              <span style={{ fontSize: '0.8rem', color: '#64748b' }}>{new Date(note.created_at).toLocaleString('pt-BR')}</span>
            </div>
            <p style={{ margin: 0, lineHeight: '1.5' }}>{note.content}</p>
            {note.metadata?.ai_reply && (
              <div style={{ marginTop: '1rem', padding: '1rem', backgroundColor: '#0f172a', borderRadius: '4px', border: '1px dashed #334155' }}>
                <span style={{ fontSize: '0.7rem', color: '#94a3b8', display: 'block', marginBottom: '0.5' }}>RESPOSTA DO JARVIS:</span>
                <p style={{ margin: 0, fontSize: '0.9rem', color: '#cbd5e1' }}>{note.metadata.ai_reply}</p>
              </div>
            )}
          </div>
        ))}
        {(!notes || notes.length === 0) && <p>Nenhum registro encontrado no Cérebro ainda.</p>}
      </section>
    </main>
  );
}