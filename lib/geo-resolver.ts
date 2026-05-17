/**
 * geo-resolver.ts (Camada de Compatibilidade / Raiz)
 * V13.1.5 — Proxy de Redirecionamento Estrito
 * * Mantido para garantir retrocompatibilidade com prompt-assembler, 
 * request-context e outros módulos dependentes que apontam para a raiz.
 * * Encaminha todas as funções, tipos e adaptadores legados para o novo core.
 */

export * from './geo/geo-resolver';
