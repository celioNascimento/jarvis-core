// lib/tools/executors/dossie.ts
// V1.0.0 — Atualização do dossiê com reindexação automática de L3

import { getDossie, updateDossie } from '@/lib/services/dossie.service';

export async function executeAtualizarDossie(
  p: { tema: string; conteudo: string },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const userId = Number(numericUserId);

    // 1. Busca dossiê atual
    const dossieAtual = await getDossie(userId);

    // 2. Localiza a seção do tema e substitui — ou anexa se não existir
    const secaoRegex = new RegExp(`(##\\s*${p.tema}[^\\n]*\\n)[\\s\\S]*?(?=\\n##|$)`, 'i');
    let dossieNovo: string;

    if (secaoRegex.test(dossieAtual)) {
      dossieNovo = dossieAtual.replace(secaoRegex, `## ${p.tema.toUpperCase()}\n${p.conteudo}\n\n`);
    } else {
      dossieNovo = `${dossieAtual.trim()}\n\n## ${p.tema.toUpperCase()}\n${p.conteudo}`;
    }

    // 3. Salva e reindexa
    const result = await updateDossie(userId, dossieNovo);

    return `Dossiê atualizado. Temas reindexados: ${result.themes.join(', ')}.`;
  } catch (err: any) {
    return `Erro ao atualizar dossiê: ${err.message}`;
  }
}

export async function executeConsultarDossie(
  p: { tema?: string },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const userId = Number(numericUserId);
    const dossie = await getDossie(userId);

    if (!dossie) return 'Nenhum dossiê encontrado.';

    if (p.tema) {
      const secaoRegex = new RegExp(`##\\s*${p.tema}[^\\n]*\\n[\\s\\S]*?(?=\\n##|$)`, 'i');
      const match = dossie.match(secaoRegex);
      return match ? match[0].trim() : `Tema "${p.tema}" não encontrado no dossiê.`;
    }

    return dossie;
  } catch (err: any) {
    return `Erro ao consultar dossiê: ${err.message}`;
  }
}
