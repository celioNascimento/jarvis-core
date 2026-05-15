// lib/tools/executors/relationships.ts
import { coreResolverIdContato, coreAlternarPermissaoModulo, ModuloPermissao } from '@/lib/services/relationships.service';

export async function executeAlternarPermissao(
  p: { contato: string; modulo: ModuloPermissao; habilitar: boolean },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  const numUserId = Number(numericUserId);

  try {
    const targetId = await coreResolverIdContato(p.contato);
    if (!targetId) {
      return `[ERRO] Não encontrei nenhum usuário chamado ou com email "${p.contato}".`;
    }

    const result = await coreAlternarPermissaoModulo(numUserId, targetId, p.modulo, p.habilitar);

    const nomesModulos: Record<string, string> = {
      'shopping_enabled': 'Lista de Compras',
      'projects_enabled': 'Projetos',
      'agenda_enabled': 'Agenda / Calendário'
    };

    const moduloNome = nomesModulos[p.modulo] || p.modulo;
    const status = p.habilitar ? 'LIGADO 🟢' : 'DESLIGADO 🔴';

    if (!result.alterado) {
      return `A permissão de **${moduloNome}** com ${p.contato} já estava ${status}.`;
    }

    return `Sucesso! O compartilhamento de **${moduloNome}** com ${p.contato} foi ${status}.`;
  } catch (error: any) {
    return `[ERRO] ${error.message}`;
  }
}
