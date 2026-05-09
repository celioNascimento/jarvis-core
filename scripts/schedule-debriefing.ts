// scripts/schedule-debriefing.ts
// Roda UMA VEZ para registrar o cron diário no QStash.
//
// Uso:
//   npx tsx scripts/schedule-debriefing.ts
//
// Depois de rodar, o QStash chama /api/debriefing/run todo dia às 03:00 (Brasília = 06:00 UTC).
// Para cancelar: acesse o painel do QStash e delete o schedule.

import * as dotenv from 'dotenv';
import * as path from 'path';

// Carrega o .env.local da raiz do projeto (onde Next.js guarda as variáveis)
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { Client } from '@upstash/qstash';

async function main() {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('QSTASH_TOKEN não definida no .env.local');

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!baseUrl) throw new Error('NEXT_PUBLIC_APP_URL não definida no .env.local');

  const qstash      = new Client({ token });
  const destination = `${baseUrl}/api/debriefing/run`;

  const res = await qstash.schedules.create({
    destination,
    cron:    '0 6 * * *',   // 06:00 UTC = 03:00 Brasília
    retries: 2,
    body:    JSON.stringify({ source: 'cron' }),
  });

  console.log('✅ Schedule criado com sucesso!');
  console.log('   scheduleId:', res.scheduleId);
  console.log('   destino:   ', destination);
  console.log('   cron:       0 6 * * * (03:00 Brasília)');
}

main().catch(err => {
  console.error('❌ Erro ao criar schedule:', err);
  process.exit(1);
});