import { getWeatherInsight } from '@/lib/insights/weather-insights';
import { getSession } from '@/lib/auth'; // seu método de autenticação

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: location } = await supabase.from('config').select('value').eq('key', `last_location_${session.user.id}`).single();
  if (!location) return Response.json({ insight: 'Localização não disponível.' });
  const { lat, lon } = JSON.parse(location.value);
  const insight = await getWeatherInsight(lat, lon, session.user.name);
  return Response.json({ insight });
}