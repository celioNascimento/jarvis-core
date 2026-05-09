// scripts/schedule-morning-review.ts
// Roda UMA VEZ para registrar o cron diário de revisão matinal no QStash.
//
// Uso:
//   npx tsx scripts/schedule-morning-review.ts
//
// Roda todo dia às 08:00 Brasília (11:00 UTC).

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { Client } from '@upstash/qstash';

async function main() {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('QSTASH_TOKEN não definida no .env.local');

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!baseUrl) throw new Error('NEXT_PUBLIC_APP_URL não definida no .env.local');

  const qstash      = new Client({ token });
  const destination = `${baseUrl}/api/debriefing/morning-review`;

  const res = await qstash.schedules.create({
    destination,
    cron:    '0 11 * * *',  // 11:00 UTC = 08:00 Brasília
    retries: 2,
    body:    JSON.stringify({ source: 'cron' }),
  });

  console.log('✅ Schedule de revisão matinal criado!');
  console.log('   scheduleId:', res.scheduleId);
  console.log('   destino:   ', destination);
  console.log('   cron:       0 11 * * * (08:00 Brasília)');
}

main().catch(err => {
  console.error('❌ Erro ao criar schedule:', err);
  process.exit(1);
});