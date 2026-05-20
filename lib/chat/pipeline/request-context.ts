// lib/chat/pipeline/request-context.ts
// Fase 1 — Parse, Auth, Geo, Dedup

import { NextRequest } from 'next/server';
import { Redis } from '@upstash/redis';
import { supabase, getOrCreateSession } from '@/lib/jarvis';
import {
  updateGeoState,
  normalizeLocationForModules,
  type GeoState,
  type UserLocation,
} from '@/lib/geo-resolver';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ─── Tipos exportados ─────────────────────────────────────────────────────────

export interface RawLocation {
  lat?: number;
  latitude?: number;
  lng?: number;
  longitude?: number;
  lon?: number;
  label?: string;
  city?: string;
}

export interface ParsedLocation {
  lat: number | null;
  lng: number | null;
  label?: string;
  city?: string;
}

export interface VoiceSettings {
  provider: 'openai' | 'elevenlabs';
  voiceId: string;
}

export interface LocalMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequestContext {
  // Request
  message: string;
  userEmail: string;
  speak: boolean;
  voiceSettings: VoiceSettings;
  sessionId: string;
  requestSignature: string;

  // Usuário (do Supabase)
  user: {
    id: number;
    auth_user_id: string;
    nickname: string;
    assistant_name: string;
    plan: string;
    preferred_voice: string;
  };

  // Localização
  rawLocation: ParsedLocation | null;
  resolvedLocation: GeoState | null;
  normalizedLocation: ReturnType<typeof normalizeLocationForModules>;

  // Histórico local (frontend)
  localHistory: LocalMessage[];

  // Dedup
  dedupKey: string;
  replyKey: string;
  isCachedReply: boolean;
  cachedReply: string | null;

  // Tempo
  startTime: number;
}

// ─── Parser de localização ────────────────────────────────────────────────────

function parseLocation(raw: unknown): ParsedLocation | null {
  if (!raw) return null;
  try {
    const parsed: RawLocation =
      typeof raw === 'string' ? JSON.parse(raw) : (raw as RawLocation);
    if (!parsed || typeof parsed !== 'object') return null;

    const lat = parsed.lat ?? parsed.latitude ?? null;
    const lng = parsed.lng ?? parsed.longitude ?? parsed.lon ?? null;

    return { lat, lng, label: parsed.label, city: parsed.city };
  } catch {
    console.warn('[RequestContext] Falha ao parsear location JSON');
    return null;
  }
}

function geoStateToUserLocation(state: GeoState): UserLocation {
  return {
    lat:     state.lat,
    lng:     state.lng,
    label:   state.label,
    city:    state.city,
    state:   state.state,
    country: state.country,
  };
}

// ─── Extrator de body ─────────────────────────────────────────────────────────

async function extractBody(req: NextRequest): Promise<{
  message: string;
  userEmail: string;
  speak: boolean;
  voiceSettings: VoiceSettings | null;
  sessionId: string | null;
  rawLocation: ParsedLocation | null;
  localHistory: LocalMessage[];
}> {
  const contentType = req.headers.get('content-type') || '';
  const isMultipart = contentType.includes('multipart');

  if (isMultipart) {
    const body = await req.formData();
    let parsedVoice = null;
    try {
      const vsStr = body.get('voiceSettings') as string;
      if (vsStr) parsedVoice = JSON.parse(vsStr);
    } catch { }

    let localHistory: LocalMessage[] = [];
    try {
      const lhStr = body.get('localHistory') as string;
      if (lhStr) localHistory = JSON.parse(lhStr);
    } catch { }

    return {
      message:      (body.get('message') as string) || '',
      userEmail:    (body.get('userEmail') as string) || '',
      speak:        body.get('speak') === 'true',
      voiceSettings: parsedVoice,
      sessionId:    (body.get('sessionId') as string | null),
      rawLocation:  parseLocation(body.get('location')),
      localHistory,
    };
  }

  const body = await req.json();
  return {
    message:      body.message || '',
    userEmail:    body.userEmail || '',
    speak:        !!body.speak,
    voiceSettings: body.voiceSettings || null,
    sessionId:    body.sessionId ?? null,
    rawLocation:  parseLocation(body.location),
    localHistory: body.localHistory || [],
  };
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

async function checkDedup(
  sessionId: string,
  message: string
): Promise<{ dedupKey: string; replyKey: string; isCachedReply: boolean; cachedReply: string | null }> {
  const timeSlot = Math.floor(Date.now() / 60000);
  const sig = `${sessionId}_${Buffer.from(message.substring(0, 40)).toString('base64')}_${timeSlot}`;
  const dedupKey = `chat_dedup:${sig}`;
  const replyKey = `chat_reply:${sig}`;

  const isFirst = await redis.set(dedupKey, '1', { nx: true, ex: 60 });

  if (isFirst) {
    return { dedupKey, replyKey, isCachedReply: false, cachedReply: null };
  }

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const cached = await redis.get<string>(replyKey);
    if (cached) {
      return { dedupKey, replyKey, isCachedReply: true, cachedReply: cached };
    }
  }

  return { dedupKey, replyKey, isCachedReply: false, cachedReply: null };
}

// ─── Entrypoint público ───────────────────────────────────────────────────────

export async function buildRequestContext(
  req: NextRequest
): Promise<ChatRequestContext> {
  const startTime = Date.now();

  // 1. Extrai body
  const {
    message, userEmail, speak, voiceSettings,
    sessionId: incomingSessionId, rawLocation, localHistory,
  } = await extractBody(req);

  // 2. Autentica usuário
  const { data: user } = await supabase
    .from('users')
    .select('id, auth_user_id, nickname, assistant_name, plan, preferred_voice')
    .eq('email', userEmail)
    .single();

  if (!user) {
    throw Object.assign(new Error('Auth failed'), { statusCode: 401 });
  }

  // 3. Sessão
  const sessionId = incomingSessionId || await getOrCreateSession(String(user.id));

  // 4. Dedup
  const dedup = await checkDedup(sessionId, message);

  // 5. Geo
  let resolvedLocation: GeoState | null = null;

  if (rawLocation?.lat != null && rawLocation.lng != null) {
    resolvedLocation = await updateGeoState(
      String(user.id),
      rawLocation.lat,
      rawLocation.lng
    );
  } else {
    const { getGeoState } = await import('@/lib/geo-resolver');
    resolvedLocation = await getGeoState(String(user.id));
  }

  // 6. normalizedLocation
  const normalizedLocation = resolvedLocation
    ? normalizeLocationForModules(geoStateToUserLocation(resolvedLocation))
    : null;

  // 7. Assinatura
  const timeSlot = Math.floor(Date.now() / 60000);
  const requestSignature = `${sessionId}_${Buffer.from(message.substring(0, 40)).toString('base64')}_${timeSlot}`;

  // 8. Voz
  const dbVoice = user.preferred_voice || 'alloy';
  const inferredProvider = dbVoice.length > 10 ? 'elevenlabs' : 'openai';
  const finalVoiceSettings = voiceSettings || { provider: inferredProvider, voiceId: dbVoice };

  return {
    message,
    userEmail,
    speak,
    voiceSettings: finalVoiceSettings,
    sessionId,
    requestSignature,
    user: {
      id:              user.id,
      auth_user_id:    user.auth_user_id,
      nickname:        user.nickname || 'Usuário',
      assistant_name:  user.assistant_name || 'Lev',
      plan:            user.plan || 'free',
      preferred_voice: user.preferred_voice || 'alloy',
    },
    rawLocation,
    resolvedLocation,
    normalizedLocation,
    localHistory,
    ...dedup,
    startTime,
  };
}
