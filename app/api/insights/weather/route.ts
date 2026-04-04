// app/api/insights/weather/route.ts
import { getWeatherInsight } from '@/lib/insights/weather-insights';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';

export async function GET(req: Request) {
  const supabase = createRouteHandlerClient({ cookies });

  // Auth via Supabase session (mesmo padrão do projeto)
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Busca o numeric ID — mesmo padrão do chat/route.ts
  const { data: userRecord } = await supabase
    .from('users')
    .select('id, nickname')
    .eq('auth_user_id', session.user.id)
    .maybeSingle();

  if (!userRecord) {
    return Response.json({ error: 'Usuário não encontrado' }, { status: 404 });
  }

  const numericUserId = String(userRecord.id);

  // Chave idêntica à usada no chat/route.ts: last_location_{numericUserId}
  const { data: locationData } = await supabase
    .from('config')
    .select('value')
    .eq('key', `last_location_${numericUserId}`)
    .single();

  if (!locationData?.value) {
    return Response.json({ insight: 'Localização não disponível.' });
  }

  const { latitude, longitude } = JSON.parse(locationData.value);
  const userName = userRecord.nickname || session.user.email?.split('@')[0];

  const insight = await getWeatherInsight(latitude, longitude, userName);
  return Response.json({ insight });
}