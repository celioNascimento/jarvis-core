// lib/crypto-utils.ts
import crypto from 'crypto';

// A chave precisa ter exatos 32 bytes (256 bits).
// Adicione no seu .env.local e nas variáveis de ambiente da Vercel:
// ENCRYPTION_KEY=sua-chave-super-secreta-de-32-caracteres-aqui
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-key-para-dev-apenas-1234';
const ALGORITHM = 'aes-256-gcm';

/**
 * Criptografa um texto (ex: conteúdo do brain ou principles).
 * Retorna uma string combinando IV, AuthTag e o dado cifrado.
 */
export function encrypt(text: string): string {
  // Vetor de inicialização (IV) aleatório de 12 bytes
  const iv = crypto.randomBytes(12);
  
  // Garante que a chave tenha 32 bytes
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Tag de autenticação (GCM)
  const authTag = cipher.getAuthTag().toString('hex');
  
  // Formato padronizado para salvar no banco: iv:authTag:encryptedText
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Descriptografa o texto cifrado pelo método acima.
 * Possui fallback para retornar o texto original se ele não estiver criptografado
 * (Essencial para a migração progressiva dos dados antigos).
 */
export function decrypt(encryptedData: string): string {
  try {
    const parts = encryptedData.split(':');
    
    // Se não seguir o padrão de 3 partes, assume que é texto plano (dado antigo)
    if (parts.length !== 3) return encryptedData;

    const [ivHex, authTagHex, encryptedText] = parts;
    const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('[Crypto] Falha na descriptografia:', error);
    return encryptedData; // Fallback de segurança
  }
}

/**
 * Normaliza a string removendo acentos e passando para minúsculas.
 * Evita que "Graça" e "graca" gerem hashes diferentes no banco.
 */
export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .normalize('NFD') // Separa caracteres acentuados
    .replace(/[\u0300-\u036f]/g, ''); // Remove os diacríticos (acentos)
}

/**
 * Gera o Índice Cego (Hash SHA-256) para as tags/entidades.
 * O banco armazenará apenas isso, permitindo buscas exatas sem ler a palavra real.
 */
export function hashBlindIndex(tag: string): string {
  const normalized = normalizeTag(tag);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}