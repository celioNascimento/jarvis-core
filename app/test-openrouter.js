// test-openrouter.js
// Teste direto da API OpenRouter
require('dotenv').config();

async function test() {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'Jarvis AI',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.0-flash-001',
      messages: [{ role: 'user', content: 'Olá' }],
      max_tokens: 50,
    }),
  });

  console.log('Status:', res.status);
  console.log('Resposta:', await res.text());
}

test();