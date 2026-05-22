// lib/chat/pipeline/extractors/family.extractor.ts
// V1.1 — Tipagem Estrita Resolvida

import { callAI, safeParseJSON } from '../../../Utils/ai-helpers';
import { familyService } from '@/lib/services/family.service';

// ── TIPAGEM ESTRITA DO RETORNO DA IA ─────────────────────────────────
interface ExtractedFamilyData {
    esposa?: { nome?: string; aniversario?: string } | null;
    marido?: { nome?: string; aniversario?: string } | null;
    filhos?: Array<{ nome?: string; nascimento?: string }> | null;
    pai?: any; // Mantido any para compatibilidade com upsertParent se ele aceitar string/obj
    mae?: any;
}

export async function processFamilyData(userId: string, userMessage: string, gaps: any[]): Promise<void> {
    // 1. APENAS EXTRAÇÃO DE DADOS (IA)
    const prompt = `Extraia dados familiares afirmados explicitamente pelo USUÁRIO. Mensagem: "${userMessage}"
    Retorne APENAS JSON (null para não mencionados):
    {"esposa": {"nome": null, "aniversario": null}, "filhos": [{"nome": null, "nascimento": null}], "pai": null, "mae": null}`;

    const rawData = await callAI(prompt, 400);
    
    // O cast garante ao TypeScript que o objeto lido possui as propriedades corretas
    const data = safeParseJSON(rawData) as ExtractedFamilyData | null;
    
    if (!data) return;

    // 2. BUSCA O PERFIL ATUAL (Para que o serviço saiba o que atualizar)
    // SEM ISSO, o 'currentProfile' não existe!
    const currentProfile = await familyService.getCurrentProfile(userId);

    // 3. DELEGAÇÃO PARA O SERVIÇO
    try {
        // Cônjuge
        const conjuge = data.esposa?.nome ? data.esposa : data.marido?.nome ? data.marido : null;
        if (conjuge) {
            await familyService.upsertSpouse(userId, conjuge, currentProfile);
        }

        // Filhos
        if (data.filhos && data.filhos.length > 0) {
            for (const filho of data.filhos) {
                await familyService.upsertChild(userId, filho);
            }
        }

        // Pais
        if (data.pai) {
            await familyService.upsertParent(userId, data.pai, 'father_name', currentProfile);
        }
        if (data.mae) {
            await familyService.upsertParent(userId, data.mae, 'mother_name', currentProfile);
        }
    } catch (err) {
        console.error('[Family Extractor] Falha ao injetar dados via serviço:', err);
    }
}