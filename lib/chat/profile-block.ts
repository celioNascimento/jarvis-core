// lib/chat/profile-block.ts
// Camada de perfil unificada — injeta no system prompt tudo que é estático ou semi-estático.
// Lê em paralelo de todas as tabelas relevantes do schema jarvis.
// Não depende de RAG ou embedding — sempre presente, nunca esquece.

export interface ProfileBlockOptions {
  userId: number;      
  authUserId: string;   
  authorName: string;
  contexts?: string[];  
}

export async function buildProfileBlock({
  userId,
  authorName,
  masterContext,
}: ProfileBlockOptions & { masterContext: any }): Promise<string> {
  
  if (!masterContext) return '';

  const {
    relationships = [],
    events = [],
    budgets = [],
    transactions = [],
  } = masterContext;

  const sections: string[] = [];

  // 1. [PESSOAS PRÓXIMAS] - Consome masterContext.relationships
  if (relationships.length > 0) {
    const lines = relationships.map((r: any) => {
      const header = `${r.contact_name || 'Desconhecido'} (${r.relationship_type})`;
      return `- ${header}`;
    });
    sections.push(`[PESSOAS PRÓXIMAS]\n${lines.join('\n')}`);
  }

  // 2. [AGENDA] - Consome masterContext.events
  if (events.length > 0) {
    const lines = events.slice(0, 7).map((e: any) => {
      const date = new Date(e.start_at).toLocaleDateString('pt-BR');
      return `- ${e.title} · ${date}`;
    });
    sections.push(`[AGENDA INTERNA]\n${lines.join('\n')}`);
  }

  // 3. [FINANÇAS] - Consome masterContext.budgets e .transactions
  if (budgets.length > 0 || transactions.length > 0) {
    const fin: string[] = [];
    
    if (budgets.length > 0) {
      const bLines = budgets.map((b: any) => `- R$ ${Number(b.amount).toFixed(2)} restantes`);
      fin.push(`Orçamentos:\n${bLines.join('\n')}`);
    }
    
    if (transactions.length > 0) {
      const tLines = transactions.slice(0, 5).map((t: any) => {
        const sign = t.type === 'income' ? '+' : '-';
        return `- ${sign}R$ ${Number(t.amount).toFixed(2)} · ${t.description}`;
      });
      fin.push(`Últimas transações:\n${tLines.join('\n')}`);
    }
    
    sections.push(`[FINANÇAS]\n${fin.join('\n\n')}`);
  }

  return sections.join('\n\n');
}