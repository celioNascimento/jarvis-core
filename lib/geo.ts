// lib/geo.ts

export async function checkProximidade(lat: number, lng: number): Promise<string> {
  try {
    // É necessário ter essa variável configurada no .env da Vercel
    const apiKey = process.env.GOOGLE_PLACES_API_KEY; 
    
    if (!apiKey) {
      console.warn("[Geo] GOOGLE_PLACES_API_KEY não configurada.");
      return `[LOCALIZAÇÃO ATUAL DO CELIO]\nLat: ${lat}, Lng: ${lng}\nCidade: Londrina, PR\n(Integração com o mapa pendente de chave API)`;
    }

    const radius = 1000; // Raio de 1km para a busca

    // 1. Busca por Mercados Próximos (Nearby Search)
    const marketRes = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=supermarket&key=${apiKey}`);
    const marketData = await marketRes.json();
    
    // 2. Busca por "White Martins" na região (Text Search)
    const wmRes = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=White+Martins&location=${lat},${lng}&radius=${radius}&key=${apiKey}`);
    const wmData = await wmRes.json();

    let contextString = `[LOCALIZAÇÃO ATUAL DO CELIO]\nLat: ${lat}, Lng: ${lng}\nCidade: Londrina, PR\n\n[PONTOS DE INTERESSE PRÓXIMOS (< 1km)]\n`;
    let foundSomething = false;

    // Injeta a White Martins se estiver no raio
    if (wmData.results && wmData.results.length > 0) {
      contextString += `- 🏭 Unidade White Martins: ${wmData.results[0].name} (${wmData.results[0].formatted_address})\n`;
      foundSomething = true;
    }

    // Injeta até 2 mercados próximos
    if (marketData.results && marketData.results.length > 0) {
      const topMarkets = marketData.results.slice(0, 2);
      topMarkets.forEach((m: any) => {
        contextString += `- 🛒 Mercado: ${m.name} (${m.vicinity})\n`;
      });
      foundSomething = true;
    }

    if (!foundSomething) {
      contextString += "- Nenhum mercado ou unidade da White Martins num raio de 1km.\n";
    }

    return contextString;

  } catch (error) {
    console.error("[Geo] Erro ao buscar proximidade:", error);
    return `[LOCALIZAÇÃO ATUAL DO CELIO]\nLat: ${lat}, Lng: ${lng}\nCidade: Londrina, PR`;
  }
}