// lib/utils/sanitizer.ts

export function sanitizeSensitiveData(text: string): string {
    if (!text) return text;
  
    // Lista de Padrões (Expressões Regulares / Regex)
    const patterns = [
      // 1. Chaves da OpenAI (Padrão antigo 'sk-' e novo 'sk-proj-')
      /sk-[a-zA-Z0-9]{30,}/g,
      /sk-proj-[a-zA-Z0-9_-]+/g,
  
      // 2. Tokens JWT (Padrão usado pelo Supabase e Vercel para autenticação)
      // Começam sempre com 'eyJ'
      /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
  
      // 3. Senhas vazadas em links de banco de dados (ex: postgres://user:SENHA@banco...)
      /\/\/[^:]+:[^@]+@/g,
  
      // 4. Tokens de Autorização padrão (Bearer)
      /Bearer\s+[a-zA-Z0-9\-_.]+/gi
    ];
  
    let sanitizedText = text;
  
    // Varre o texto e substitui qualquer vazamento por um aviso seguro
    patterns.forEach((pattern) => {
      sanitizedText = sanitizedText.replace(pattern, '[DADO_PROTEGIDO]');
    });
  
    return sanitizedText;
  }