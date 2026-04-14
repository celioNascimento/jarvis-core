"use client"
// src/hooks/useUserProfile.ts
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/jarvis';

const storage = {
  getItem: (key: string): string | null => {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  setItem: (key: string, value: string): void => {
    try { localStorage.setItem(key, value); } catch {}
  },
};

export function useUserProfile(userId: string) {
  const [assistantName, setAssistantName] = useState('Lev');
  const [preferredName, setPreferredName] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;

    async function fetchProfile() {
      // 1. Carrega cache local imediatamente (evita flash)
      const cachedAssistant = storage.getItem('lev_assistant_name');
      const cachedName = storage.getItem('lev_preferred_name');
      if (cachedAssistant) setAssistantName(cachedAssistant);
      if (cachedName) setPreferredName(cachedName);

      // 2. Busca do banco e atualiza cache
      const { data, error } = await (supabase as any)
        .schema('jarvis')
        .from('users')
        .select('assistant_name, preferred_name')
        .eq('auth_user_id', userId)
        .single();

      if (error) {
        console.warn('[useUserProfile] erro:', error.message);
      } else if (data) {
        if (data.assistant_name) {
          setAssistantName(data.assistant_name);
          storage.setItem('lev_assistant_name', data.assistant_name);
        }
        if (data.preferred_name) {
          setPreferredName(data.preferred_name);
          storage.setItem('lev_preferred_name', data.preferred_name);
        }
      }
      setLoading(false);
    }

    fetchProfile();
  }, [userId]);

  return { assistantName, preferredName, loading };
}