// lib/services/family.service.ts
import { supabase } from '@/lib/jarvis';
import { 
  upsertAlias, 
  upsertEvent, 
  normalizeDate, 
  getLifePhase, 
  upsertPerson 
} from '../Utils/db-helpers';

export const familyService = {
  
  async getCurrentProfile(userId: string) {
    const { data } = await supabase
      .from('user_profiles')
      .select('spouse_name, spouse_birthday, father_name, mother_name')
      .eq('user_id', userId)
      .maybeSingle();
    return data;
  },

  async upsertSpouse(userId: string, conjuge: any, currentProfile: any) {
    if (!conjuge?.nome) return;

    const patch: Record<string, any> = { user_id: userId, updated_at: new Date().toISOString() };
    
    // Regra: Atualiza o nome se o novo tiver mais palavras (nome completo)
    if (!currentProfile?.spouse_name || conjuge.nome.split(' ').length > currentProfile.spouse_name.split(' ').length) {
      patch.spouse_name = conjuge.nome;
    }
    if (conjuge.aniversario && !currentProfile?.spouse_birthday) {
      patch.spouse_birthday = normalizeDate(conjuge.aniversario);
    }
    if (conjuge.telefone) patch.spouse_phone = conjuge.telefone;

    await supabase.from('user_profiles').upsert(patch, { onConflict: 'user_id' });
    
    if (conjuge.apelido) {
      await upsertAlias(userId, conjuge.apelido, 'spouse', null, conjuge.nome);
    }
    
    if (conjuge.aniversario) {
      await upsertEvent(userId, {
        title: `Aniversário ${conjuge.nome}`, 
        event_date: normalizeDate(conjuge.aniversario),
        category: 'family', 
        priority: 'alta', 
        decay_type: 'recurring_annual', 
        emotional_weight: 0.95,
      });
    }
    
    await upsertPerson(userId, conjuge.nome, 'spouse', { noteText: conjuge.nota ?? undefined });
  },

  async upsertChild(userId: string, filho: any) {
    if (!filho?.nome) return;

    const firstName = filho.nome.split(' ')[0].toLowerCase();
    const { data: allChildren } = await supabase
      .from('children')
      .select('id, name, birth_date, nickname, child_user_id')
      .eq('parent_id', userId);
      
    const ex = (allChildren || []).find((c: any) => c.name.split(' ')[0].toLowerCase() === firstName) || null;

    let birth_date: string | null = null;
    if (filho.nascimento) birth_date = normalizeDate(filho.nascimento);
    else if (filho.idade) birth_date = `${new Date().getFullYear() - filho.idade}-01-01`;

    const ageReal = birth_date ? Math.floor((Date.now() - new Date(birth_date).getTime()) / (1000 * 60 * 60 * 24 * 365.25)) : filho.idade;
    const life_phase = getLifePhase(ageReal);

    const existingName = ex?.name || '';
    const existingWords = existingName.trim().split(/\s+/).length;
    const newWords = filho.nome.trim().split(/\s+/).length;
    const nameToSave = (!existingName || newWords > existingWords) ? filho.nome : existingName;

    let nicknameToSave: string | null = ex?.nickname || null;
    if (ex?.child_user_id) {
      const { data: childUser } = await supabase.from('user_profiles').select('preferred_name, full_name').eq('user_id', String(ex.child_user_id)).maybeSingle();
      nicknameToSave = childUser?.preferred_name || childUser?.full_name?.split(' ')[0] || null;
    } else {
      const apelido = filho.apelido || nameToSave.split(' ')[0];
      const apWords = apelido.trim().split(/\s+/).length;
      const curWords = (ex?.nickname || '').trim().split(/\s+/).length;
      if (!ex?.nickname || apWords > curWords) nicknameToSave = apelido;
    }

    let generoNorm: string | null = null;
    if (filho.genero) generoNorm = (filho.genero.toLowerCase() === 'm' || filho.genero.toLowerCase().startsWith('masc')) ? 'masculino' : 'feminino';
    else if (filho.pronome) generoNorm = filho.pronome === 'ele' ? 'masculino' : filho.pronome === 'ela' ? 'feminino' : null;

    const childData: Record<string, any> = { name: nameToSave, updated_at: new Date().toISOString() };
    if (birth_date) childData.birth_date = birth_date;
    if (life_phase && (!ex || birth_date)) childData.life_phase = life_phase;
    if (nicknameToSave) childData.nickname = nicknameToSave;
    if (generoNorm) childData.gender = generoNorm;
    if (filho.escola) childData.school_name = filho.escola;
    if (filho.serie) childData.school_grade = filho.serie;
    if (filho.turno) childData.school_shift = filho.turno;
    if (filho.necessidades_especiais) childData.special_needs = filho.necessidades_especiais;
    if (filho.outro_pai) childData.other_parent_name = filho.outro_pai === 'desconhecido' ? null : filho.outro_pai;

    let childId: string;
    if (ex?.id) {
      await supabase.from('children').update(childData).eq('id', ex.id);
      childId = ex.id;
    } else {
      const { data: inserted } = await supabase.from('children').insert({ parent_id: userId, ...childData }).select('id').single();
      childId = inserted?.id;
    }

    if (nicknameToSave && nicknameToSave.toLowerCase() !== firstName) {
      await upsertAlias(userId, nicknameToSave, 'child', childId || null, nameToSave);
    }

    if (birth_date) {
      await upsertEvent(userId, {
        title: `Aniversário ${nameToSave}`, event_date: birth_date, category: 'family',
        notes: `${life_phase} — ${ageReal} anos`, priority: 'alta', decay_type: 'recurring_annual', emotional_weight: 0.90,
      });
    }
    
    await upsertPerson(userId, nameToSave, 'child', { nickname: nicknameToSave ?? undefined });
  },

  async upsertParent(userId: string, parentData: any, parentType: 'father_name' | 'mother_name', currentProfile: any) {
    if (!parentData?.nome || currentProfile?.[parentType]) return;

    const patch = { user_id: userId, [parentType]: parentData.nome, updated_at: new Date().toISOString() };
    await supabase.from('user_profiles').upsert(patch, { onConflict: 'user_id' });
    
    if (parentData.apelido) {
      await upsertAlias(userId, parentData.apelido, 'parent', null, parentData.nome);
    }
    await upsertPerson(userId, parentData.nome, 'parent', { nickname: parentData.apelido ?? undefined });
  }
};