import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
      const body = await req.json();

          // 1. Inicialização do Supabase com Schema 'jarvis'
              const supabase = createClient(
                    process.env.SUPABASE_URL!,
                          process.env.SUPABASE_SERVICE_ROLE_KEY!,
                                {
                                        db: { schema: 'jarvis' }
                                              }
                                                  );

                                                      // 2. Extração básica da mensagem do Telegram
                                                          const messageText = body.message?.text || "";
                                                              const chatId = body.message?.chat?.id;

                                                                  if (!messageText) {
                                                                        return NextResponse.json({ ok: true });
                                                                            }

                                                                                // 3. Lógica de Categorização Simples (Pode ser expandida com IA depois)
                                                                                    let category = 'Nota';
                                                                                        let projectTag = 'PQF'; // Default para o seu projeto principal

                                                                                            if (messageText.toLowerCase().includes('dúvida') || messageText.includes('?')) {
                                                                                                  category = 'Dúvida';
                                                                                                      } else if (messageText.toLowerCase().includes('ideia') || messageText.toLowerCase().includes('estacionar')) {
                                                                                                            category = 'Ideia_Estacionada';
                                                                                                                } else if (messageText.toLowerCase().includes('log') || messageText.toLowerCase().includes('erro')) {
                                                                                                                      category = 'Log_Tecnico';
                                                                                                                          }

                                                                                                                              // 4. Inserção no Banco de Dados
                                                                                                                                  const { error: dbError } = await supabase
                                                                                                                                        .from('brain')
                                                                                                                                              .insert([
                                                                                                                                                      {
                                                                                                                                                                content: messageText,
                                                                                                                                                                          category: category,
                                                                                                                                                                                    project_tag: projectTag,
                                                                                                                                                                                              context_status: 'Execução'
                                                                                                                                                                                                      }
                                                                                                                                                                                                            ]);

                                                                                                                                                                                                                if (dbError) {
                                                                                                                                                                                                                      console.error("ERRO SUPABASE:", dbError);
                                                                                                                                                                                                                            throw new Error(`Erro ao salvar no banco: ${dbError.message}`);
                                                                                                                                                                                                                                }

                                                                                                                                                                                                                                    // 5. Resposta de Confirmação para o Telegram
                                                                                                                                                                                                                                        const telegramToken = process.env.TELEGRAM_TOKEN;
                                                                                                                                                                                                                                            const responseText = `✅ *Registrado no Jarvis*\n\n*Categoria:* ${category}\n*Conteúdo:* ${messageText}`;

                                                                                                                                                                                                                                                await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                                                                                                                                                                                                                                                      method: 'POST',
                                                                                                                                                                                                                                                            headers: { 'Content-Type': 'application/json' },
                                                                                                                                                                                                                                                                  body: JSON.stringify({
                                                                                                                                                                                                                                                                          chat_id: chatId,
                                                                                                                                                                                                                                                                                  text: responseText,
                                                                                                                                                                                                                                                                                          parse_mode: 'Markdown'
                                                                                                                                                                                                                                                                                                }),
                                                                                                                                                                                                                                                                                                    });

                                                                                                                                                                                                                                                                                                        return NextResponse.json({ ok: true });

                                                                                                                                                                                                                                                                                                          } catch (error: any) {
                                                                                                                                                                                                                                                                                                              // Log detalhado para você encontrar no Dashboard da Vercel
                                                                                                                                                                                                                                                                                                                  console.error("LOG DE RUNTIME JARVIS:", error.message);
                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                          return NextResponse.json(
                                                                                                                                                                                                                                                                                                                                { error: "Erro interno no processamento do Jarvis" },
                                                                                                                                                                                                                                                                                                                                      { status: 500 }
                                                                                                                                                                                                                                                                                                                                          );
                                                                                                                                                                                                                                                                                                                                            }
                                                                                                                                                                                                                                                                                                                                            }
                                                                                                                                                                                                                                                                                                                                            