// scripts/schedule-decay.ts
// Roda UMA VEZ para registrar o cron semanal de decaimento no QStash.
//
// Uso:
//   npx tsx scripts/schedule-decay.ts
//
// Roda toda segunda-feira às 04:00 Brasília (07:00 UTC).
// Para cancelar: acesse o painel do QStash e delete o schedule.

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
  const destination = `${baseUrl}/api/debriefing/decay`;

  const res = await qstash.schedules.create({
    destination,
    cron:    '0 7 * * 1',   // 07:00 UTC toda segunda = 04:00 Brasília
    retries: 2,
    body:    JSON.stringify({ source: 'cron' }),
  });

  console.log('✅ Schedule de decaimento criado com sucesso!');
  console.log('   scheduleId:', res.scheduleId);
  console.log('   destino:   ', destination);
  console.log('   cron:       0 7 * * 1 (toda segunda às 04:00 Brasília)');
}

main().catch(err => {
  console.error('❌ Erro ao criar schedule:', err);
  process.exit(1);
});