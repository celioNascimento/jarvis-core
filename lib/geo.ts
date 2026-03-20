export async function checkProximidade(lat: number, lng: number): Promise<string> {
  try {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;

    if (!apiKey) {
      console.warn("[Geo] Chave API não encontrada.");
      return `[LOCALIZAÇÃO]\nEndereço não disponível (Configuração pendente).`;
    }

    const radius = 1000;

    // 1. REVERSE GEOCODING
    const geoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`);
    const geoData = await geoRes.json();
    const enderecoCompleto = geoData.results?.[0]?.formatted_address || "Endereço não identificado";

    // 2. BUSCA DE PONTOS DE INTERESSE
    const marketRes = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=supermarket&key=${apiKey}`);
    const marketData = await marketRes.json();

    const wmRes = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=White+Martins&location=${lat},${lng}&radius=${radius}&key=${apiKey}`);
    const wmData = await wmRes.json();

    // 3. MONTAGEM DO CONTEXTO
    let contextString = `[CONTEXTO DE LOCALIZAÇÃO ATUAL]\n`;
    contextString += `📍 ENDEREÇO: ${enderecoCompleto}\n`;
    contextString += `(Metadados Técnicos: lat=${lat}, lng=${lng} - NÃO MENCIONE ESTES NÚMEROS A MENOS QUE SOLICITADO)\n\n`;
    contextString += `[ESTABELECIMENTOS PRÓXIMOS]\n`;

    let foundSomething = false;

    if (wmData.results && wmData.results.length > 0) {
      contextString += `- 🏭 White Martins: ${wmData.results[0].name}\n`;
      foundSomething = true;
    }

    if (marketData.results && marketData.results.length > 0) {
      marketData.results.slice(0, 2).forEach((m: any) => {
        contextString += `- 🛒 ${m.name}\n`;
      });
      foundSomething = true;
    }

    if (!foundSomething) {
      contextString += "- Nenhuma unidade industrial ou mercado relevante no raio de 1km.\n";
    }

    return contextString;

  } catch (error) {
    console.error("[Geo] Erro:", error);
    return `[LOCALIZAÇÃO]\nErro ao identificar endereço.`;
  }
}