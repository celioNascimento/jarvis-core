// lib/services/tts.ts
// Text-to-Speech via OpenAI — retorna Buffer com MP3

export type TTSVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

// Vozes recomendadas para pt-BR:
//   nova    — feminina, calorosa (boa para assistente familiar)
//   onyx    — masculina, grave
//   alloy   — neutra, clara
const DEFAULT_VOICE: TTSVoice = (process.env.TTS_VOICE as TTSVoice) || 'nova';
const DEFAULT_MODEL = 'tts-1'; // tts-1-hd para qualidade superior (2x mais caro)

/**
 * Remove markdown e tags internas antes de enviar para TTS.
 * Bullets, negrito, colchetes — o modelo lê tudo literalmente se não limpar.
 */
function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')        // **bold**
    .replace(/\*(.*?)\*/g, '$1')             // *italic*
    .replace(/`{1,3}[^`]*`{1,3}/g, '')      // `code`
    .replace(/\[.*?\]/g, '')                 // [tags internas]
    .replace(/^[-•*]\s+/gm, '')             // bullet points
    .replace(/^\d+\.\s+/gm, '')             // listas numeradas
    .replace(/https?:\/\/\S+/g, '')         // URLs
    .replace(/\n{2,}/g, '. ')               // parágrafos → pausa
    .replace(/\n/g, ' ')
    .trim();
}

/**
 * Trunca para evitar respostas longas demais no modo voz.
 * ~500 chars ≈ 30s de fala — bom limite para mobile.
 */
function truncateForSpeech(text: string, maxChars = 500): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf('.', maxChars);
  return cut > 100 ? text.slice(0, cut + 1) : text.slice(0, maxChars) + '...';
}

export interface TTSResult {
  success: boolean;
  audioBase64?: string;     // MP3 em base64 para enviar no JSON
  durationEstimateMs?: number;
  error?: string;
}

export async function synthesizeSpeech(
  text: string,
  voice: TTSVoice = DEFAULT_VOICE,
): Promise<TTSResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[TTS] OPENAI_API_KEY não configurada');
    return { success: false, error: 'TTS não configurado' };
  }

  const cleaned = cleanForSpeech(text);
  const truncated = truncateForSpeech(cleaned);

  if (!truncated) {
    return { success: false, error: 'Texto vazio após limpeza' };
  }

  console.time('[TTS] openai');
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        input: truncated,
        voice,
        response_format: 'mp3',
        speed: 1.0,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[TTS] Erro na API:', response.status, err);
      return { success: false, error: `TTS API error ${response.status}` };
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString('base64');

    // Estimativa grosseira: ~150 palavras/min, ~5 chars/palavra
    const words = truncated.split(/\s+/).length;
    const durationEstimateMs = Math.round((words / 150) * 60 * 1000);

    console.timeEnd('[TTS] openai');
    console.log(`[TTS] OK — ${truncated.length} chars, ~${Math.round(durationEstimateMs / 1000)}s, voz: ${voice}`);

    return { success: true, audioBase64, durationEstimateMs };
  } catch (e: any) {
    console.timeEnd('[TTS] openai');
    console.error('[TTS] Exceção:', e.message);
    return { success: false, error: e.message };
  }
}
