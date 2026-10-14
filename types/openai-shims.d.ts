declare module 'openai/index.js' {
  const OpenAI: any;
  export default OpenAI;
  export { OpenAI };
}

declare module 'openai/uploads.js' {
  export const toFile: any;
}
