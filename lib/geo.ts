// lib/geo.ts

export async function checkProximidade(lat: number, lng: number): Promise<string> {
  try {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY; 
    
    if (!apiKey) {
      console.warn("[Geo] GOOGLE_PLACES_API_KEY não configurada.");
      return `[LOCALIZAÇÃO DO CELIO]\nCoordenadas: ${lat}, ${lng}\nCidade: Londrina, PR\n(Integração Geocoding pendente)`;
    }

    const radius = 1000; // Raio de 1km

    // 1. REVERSE GEOCODING: Transforma coordenadas em Endereço Humano
    const geoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`);
    const geoData = await geoRes.json();
    const enderecoHumano = geoData.results?.[0]?.formatted_address || "Endereço não identificado";

    // 2. PLACES: Busca por Mercados Próximos
    const marketRes = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=supermarket&key=${apiKey}`);
    const marketData = await marketRes.json();
    
    // 3. PLACES: Busca específica pela White Martins
    const wmRes = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=White+Martins&location=${lat},${lng}&radius=${radius}&key=${apiKey}`);
    const wmData = await wmRes.json();

    // Montagem do Bloco de Contexto para o Jarvis
    let contextString = `[INFORMAÇÃO DE LOCALIZAÇÃO GEOGRÁFICA]\n`;
    contextString += `📍 Endereço Aproximado: ${enderecoHumano}\n`;
    contextString += `📌 Coordenadas: ${lat}, ${lng}\n\n`;
    contextString += `[PONTOS DE INTERESSE PRÓXIMOS (< 1km)]\n`;

    let foundSomething = false;

    // Injeta White Martins se houver match
    if (wmData.results && wmData.results.length > 0) {
      contextString += `- 🏭 Unidade White Martins: ${wmData.results[0].name} (${wmData.results[0].formatted_address})\n`;
      foundSomething = true;
    }

    // Injeta até 2 mercados principais
    if (marketData.results && marketData.results.length > 0) {
      const topMarkets = marketData.results.slice(0, 2);
      topMarkets.forEach((m: any) => {
        contextString += `- 🛒 Mercado: ${m.name} (${m.vicinity})\n`;
      });
      foundSomething = true;
    }

    if (!foundSomething) {
      contextString += "- Nenhum ponto de interesse crítico identificado no raio de 1km.\n";
    }

    return contextString;

  } catch (error) {
    console.error("[Geo] Erro crítico no radar geográfico:", error);
    return `[LOCALIZAÇÃO DO CELIO]\nCoordenadas: ${lat}, ${lng}\nLondrina, PR`;
  }
}