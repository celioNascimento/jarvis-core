// lib/geo.ts
// Cache em memória com limite fixo (100 entradas) + garbage collection
const MAX_CACHE_SIZE = 100;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos
const CLEANUP_INTERVAL = 6 * 60 * 1000; // 6 minutos

type CacheEntry = { value: string; timestamp: number };
const geoCache = new Map<string, CacheEntry>();

// 🔁 Garbage collection periódica (executa apenas uma vez no módulo)
if (typeof window === 'undefined') {
  setInterval(() => {
    const now = Date.now();
    let deleted = 0;
    for (const [key, entry] of geoCache.entries()) {
      if (now - entry.timestamp > CACHE_TTL) {
        geoCache.delete(key);
        deleted++;
      }
    }
    if (deleted > 0) {
      console.log(`[Geo] Cache cleanup: ${deleted} entradas expiradas removidas. Restantes: ${geoCache.size}`);
    }
    if (geoCache.size > MAX_CACHE_SIZE) {
      const keysToDelete = Array.from(geoCache.keys()).slice(0, geoCache.size - MAX_CACHE_SIZE);
      keysToDelete.forEach(key => geoCache.delete(key));
      console.warn(`[Geo] Cache limit enforced: ${keysToDelete.length} entradas removidas`);
    }
  }, CLEANUP_INTERVAL);
}

/**
 * Fetch com timeout e tratamento explícito de AbortError
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Timeout após ${timeoutMs}ms: ${url.substring(0, 60)}...`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Verifica proximidade e contexto geográfico do usuário
 * @param lat Latitude (-90 a 90)
 * @param lng Longitude (-180 a 180)
 * @param numericUserId Opcional: se fornecido, salva cidade/UF automaticamente ✅ CORREÇÃO CRÍTICA
 * @returns String formatada com localização e pontos de interesse próximos
 */
export async function checkProximidade(
  lat: number, 
  lng: number,
  numericUserId?: string // ✅ PARÂMETRO ADICIONADO (não quebra compatibilidade)
): Promise<string> {
  // === 1. VALIDAÇÃO DE COORDENADAS ===
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    console.error('[Geo] Coordenadas inválidas:', lat, lng);
    return `[LOCALIZAÇÃO]\nCoordenadas inválidas.`;
  }

  // === 2. CACHE EM MEMÓRIA (chave arredondada para ~111m) ===
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = geoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.debug(`[Geo] Cache HIT para ${cacheKey}`);
    return cached.value;
  }
  console.debug(`[Geo] Cache MISS para ${cacheKey}`);

  try {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    let enderecoCompleto = '';
    let bairro = '';
    let cidade = '';
    let estado = '';
    let pais = '';

    // === 3. REVERSE GEOCODING (Google → Nominatim) ===
    if (apiKey?.trim()) {
      try {
        const geoRes = await fetchWithTimeout(
          `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`,
          {},
          8000
        );
        
        if (!geoRes.ok) throw new Error(`HTTP ${geoRes.status}`);
        const geoData = await geoRes.json();

        if (geoData.status === 'OK' && geoData.results?.[0]) {
          enderecoCompleto = geoData.results[0].formatted_address;
          const comps = geoData.results[0].address_components;

          const bairroComp =
            comps.find((c: any) => c.types.includes('sublocality')) ||
            comps.find((c: any) => c.types.includes('neighborhood'));
          bairro = bairroComp?.long_name || '';

          // ✅ EXTRAÇÃO ROBUSTA: locality → administrative_area_level_2 (áreas rurais)
          const cidadeComp =
            comps.find((c: any) => c.types.includes('locality')) ||
            comps.find((c: any) => c.types.includes('administrative_area_level_2'));
          cidade = cidadeComp?.long_name || '';

          const estadoComp = comps.find((c: any) => c.types.includes('administrative_area_level_1'));
          estado = estadoComp?.short_name || estadoComp?.long_name || '';

          const paisComp = comps.find((c: any) => c.types.includes('country'));
          pais = paisComp?.short_name || '';
        } else {
          console.warn('[Geo] Google geocode falhou:', geoData.status);
        }
      } catch (e) {
        console.error('[Geo] Erro na chamada Google:', e);
      }
    }

    // Fallback para Nominatim apenas se Google não retornou contexto mínimo
    if (!cidade && !estado) {
      const contactEmail = process.env.NOMINATIM_CONTACT_EMAIL?.trim();
      
      if (!contactEmail) {
        console.error('[Geo] FATAL: NOMINATIM_CONTACT_EMAIL não configurado');
        const latMasked = lat.toFixed(2);
        const lngMasked = lng.toFixed(2);
        return `[LOCALIZAÇÃO]\nLocalização aproximada (${latMasked}, ${lngMasked})`;
      }

      const userAgent = `Jarvis/1.0 (+${contactEmail})`;

      console.log('[Geo] Usando Nominatim fallback');
      try {
        const nomRes = await fetchWithTimeout(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=pt-BR`,
          { headers: { 'User-Agent': userAgent } },
          8000
        );
        
        if (!nomRes.ok) throw new Error(`HTTP ${nomRes.status}`);
        const nomData = await nomRes.json();
        
        if (nomData.display_name) {
          enderecoCompleto = nomData.display_name;
          bairro = nomData.address?.suburb || nomData.address?.neighbourhood || '';
          cidade = nomData.address?.city || nomData.address?.town || nomData.address?.village || '';
          estado = nomData.address?.state || '';
          pais = nomData.address?.country_code?.toUpperCase() || '';
        } else {
          throw new Error('Nominatim sem resultado');
        }
      } catch (e) {
        console.error('[Geo] Nominatim também falhou:', e);
        const latMasked = lat.toFixed(2);
        const lngMasked = lng.toFixed(2);
        return `[LOCALIZAÇÃO]\nLocalização aproximada (${latMasked}, ${lngMasked})`;
      }
    }

    // === 4. MONTAGEM DO LABEL DE LOCALIZAÇÃO ===
    let locationLabel = '';
    if (bairro && cidade) locationLabel = `${bairro}, ${cidade}`;
    else if (cidade) locationLabel = cidade;
    else if (bairro) locationLabel = bairro;
    else locationLabel = enderecoCompleto.split(',')[0].trim() || 'Localização';

    // === 5. BUSCA DE PONTOS DE INTERESSE (apenas Brasil + com chave Google) ===
    let pontosInteresse = '';
    if (apiKey?.trim() && pais === 'BR') {
      try {
        const radius = 1000;
        // ✅ PARALELIZAÇÃO + VALIDAÇÃO .ok ANTES de .json()
        const [marketRes, wmRes] = await Promise.all([
          fetchWithTimeout(
            `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=supermarket&key=${apiKey}`,
            {},
            8000
          ),
          fetchWithTimeout(
            `https://maps.googleapis.com/maps/api/place/textsearch/json?query=White+Martins&location=${lat},${lng}&radius=${radius}&key=${apiKey}`,
            {},
            8000
          ),
        ]);

        if (!marketRes.ok) throw new Error(`Supermercados: HTTP ${marketRes.status}`);
        if (!wmRes.ok) throw new Error(`White Martins: HTTP ${wmRes.status}`);

        const [marketData, wmData] = await Promise.all([
          marketRes.json(),
          wmRes.json(),
        ]);

        const pontos = [];
        if (wmData.results?.[0]) pontos.push(`- 🏭 White Martins: ${wmData.results[0].name}`);
        if (marketData.results?.length) {
          marketData.results.slice(0, 2).forEach((m: any) => pontos.push(`- 🛒 ${m.name}`));
        }
        if (pontos.length) {
          pontosInteresse = `\n[ESTABELECIMENTOS PRÓXIMOS]\n${pontos.join('\n')}`;
        }
      } catch (e) {
        console.error('[Geo] Erro ao buscar pontos de interesse:', e);
      }
    }

    // ✅ SALVAMENTO AUTOMÁTICO NO SCHEMA JARVIS (CORREÇÃO CRÍTICA)
    if (numericUserId && cidade && estado) {
      await supabase
        .from('user_locations') // ✅ Cliente já aponta para schema jarvis
        .upsert(
          {
            user_id: numericUserId,
            latitude: parseFloat(lat.toFixed(6)),
            longitude: parseFloat(lng.toFixed(6)),
            city: cidade.trim(),
            state: estado.trim(),
            country: pais,
            last_updated: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        )
        .catch((e) => console.error('[Geo] Upsert localização:', e));
    }

    // === 6. MONTAGEM DO CONTEXTO FINAL ===
    const latMasked = lat.toFixed(2);
    const lngMasked = lng.toFixed(2);
    let contextString = `[LOCALIZAÇÃO]\n📍 ${locationLabel}\n`;
    contextString += `(Coordenadas aproximadas: ${latMasked}, ${lngMasked})\n`;
    if (pontosInteresse) contextString += pontosInteresse;

    geoCache.set(cacheKey, { value: contextString, timestamp: Date.now() });

    return contextString;
  } catch (error) {
    console.error('[Geo] Erro fatal:', error);
    const latMasked = lat.toFixed(2);
    const lngMasked = lng.toFixed(2);
    return `[LOCALIZAÇÃO]\nLocalização aproximada (${latMasked}, ${lngMasked})`;
  }
}