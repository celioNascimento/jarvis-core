// app/api/insights/weather/route.ts
import { getWeatherInsight } from '@/lib/insights/weather-insights';
import { supabase } from '@/lib/jarvis';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Valida o token e pega o usuário — mesmo padrão do projeto
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: userRecord } = await supabase
    .from('users')
    .select('id, nickname')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (!userRecord) {
    return Response.json({ error: 'Usuário não encontrado' }, { status: 404 });
  }

  const numericUserId = String(userRecord.id);

  const { data: locationData } = await supabase
    .from('config')
    .select('value')
    .eq('key', `last_location_${numericUserId}`)
    .single();

  if (!locationData?.value) {
    return Response.json({ insight: 'Localização não disponível.' });
  }

  const { latitude, longitude } = JSON.parse(locationData.value);
  const userName = userRecord.nickname || user.email?.split('@')[0];

  const insight = await getWeatherInsight(latitude, longitude, userName);
  return Response.json({ insight });
}