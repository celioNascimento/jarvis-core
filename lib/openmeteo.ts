

export interface DailyForecast {
    date: string;
    max: number;
    min: number;
    condition_code: number;
    rain_probability: number;
  }
  
  export interface WeatherData {
    temp: number;
    condition_code: number;
    description: string;
    humidity: number;
    wind_speed: number;
    forecast: DailyForecast[];
  }
  
  // Mapeamento simplificado de códigos WMO para descrições em PT-BR
  const WMO_CODES: Record<number, string> = {
    0: 'Céu limpo', 1: 'Principalmente limpo', 2: 'Parcialmente nublado', 3: 'Nublado',
    45: 'Nevoeiro', 48: 'Nevoeiro com geada', 51: 'Drizzle leve', 53: 'Drizzle moderado',
    55: 'Drizzle denso', 61: 'Chuva leve', 63: 'Chuva moderada', 65: 'Chuva forte',
    71: 'Neve leve', 73: 'Neve moderada', 75: 'Neve forte', 77: 'Grãos de neve',
    80: 'Pancadas de chuva leves', 81: 'Pancadas de chuva moderadas', 82: 'Pancadas de chuva violentas',
    95: 'Trovoada leve', 96: 'Trovoada com granizo',
  };
  
  export async function fetchWeather(lat: number, lon: number): Promise<WeatherData> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
  
    const res = await fetch(url);
    if (!res.ok) throw new Error('Falha ao buscar clima no Open-Meteo');
    
    const data = await res.json();
  
    return {
      temp: Math.round(data.current.temperature_2m),
      condition_code: data.current.weather_code,
      description: WMO_CODES[data.current.weather_code] || 'Desconhecido',
      humidity: data.current.relative_humidity_2m,
      wind_speed: data.current.wind_speed_10m,
      forecast: data.daily.time.map((date: string, i: number) => ({
        date,
        max: Math.round(data.daily.temperature_2m_max[i]),
        min: Math.round(data.daily.temperature_2m_min[i]),
        condition_code: data.daily.weather_code[i],
        rain_probability: data.daily.precipitation_probability_max[i]
      }))
    };
  }
  