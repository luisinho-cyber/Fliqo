import { avisosDoDia, brl, hhmm, planoDaVaga, previsaoDoDia, emHoje } from './calculos';
import { CLINICA, PROCEDIMENTOS } from './dados';
import {
  comBotoes,
  comDecisao,
  comMensagem,
  comModo,
  mudarEspera,
  mudarStatus,
  semDecisao,
  type ApiDeCena,
} from './estado';

/**
 * As seis cenas da apresentação comercial.
 *
 * Cada uma mostra um problema que custa dinheiro à clínica e o que o sistema faz
 * com ele. Os números que aparecem saem das funções de packages/core, não de
 * texto escrito à mão.
 */

export interface Cena {
  titulo: string;
  descricao: string;
  executar: (api: ApiDeCena) => void | Promise<void>;
}

const daClinica = (texto: string, hora: string) => ({ de: 'clinica', texto, hora }) as const;
const doPaciente = (texto: string, hora: string) => ({ de: 'paciente', texto, hora }) as const;

export const CENAS: Cena[] = [
  {
    titulo: 'Confirmação de véspera',
    descricao:
      'A mensagem sai com botões. Não há texto para interpretar, não há erro. Toque em "Não vou" no celular da Carla.',
    executar: (api) => {
      api.ajustar((e) => ({
        ...e,
        aba: 'dia',
        dia: 'amanha',
        selecionada: 't3',
        conversaAtiva: 'carla',
      }));
      api.ajustar((e) =>
        comBotoes(
          comMensagem(
            e,
            'carla',
            daClinica(
              `Olá, Carla. Aqui é da ${CLINICA.nome}.\nSua aplicação de toxina botulínica com a Dra. Ana é amanhã, quarta, às 14:00.\nPodemos confirmar?`,
              '14:00',
            ),
          ),
          'carla',
          [
            {
              rotulo: 'Confirmo',
              aoTocar: (a) => {
                a.ajustar((e) =>
                  mudarStatus(
                    comMensagem(e, 'carla', doPaciente('Confirmo', '14:02')),
                    't3',
                    'confirmado',
                  ),
                );
                a.avisar('Confirmado. A agenda já mostra.');
              },
            },
            {
              rotulo: 'Preciso remarcar',
              aoTocar: async (a) => {
                a.ajustar((e) => comMensagem(e, 'carla', doPaciente('Preciso remarcar', '14:02')));
                await a.esperar(600);
                a.ajustar((e) =>
                  comMensagem(
                    e,
                    'carla',
                    daClinica(
                      'Claro. Tenho quinta às 9:00 ou sexta às 15:30. Qual fica melhor para você?',
                      '14:03',
                    ),
                  ),
                );
              },
            },
            {
              rotulo: 'Não vou',
              aoTocar: async (a) => {
                a.ajustar((e) =>
                  mudarStatus(
                    comMensagem(e, 'carla', doPaciente('Não vou', '14:02')),
                    't3',
                    'cancelado',
                  ),
                );
                await a.esperar(600);
                a.ajustar((e) =>
                  comDecisao(
                    comMensagem(
                      e,
                      'carla',
                      daClinica(
                        'Obrigada por avisar, Carla. Cancelei aqui. Quando quiser remarcar, é só me chamar.',
                        '14:02',
                      ),
                    ),
                    {
                      id: 'vaga-14h',
                      severidade: 'info',
                      titulo: 'Amanhã 14:00 com a Dra. Ana ficou livre',
                      detalhe:
                        'Carla Mendes cancelou pela confirmação. A lista de espera já pode ser acionada.',
                    },
                  ),
                );
                a.avisar('Horário liberado. Ele aparece como livre na linha de amanhã.');
              },
            },
          ],
        ),
      );
    },
  },

  {
    titulo: 'O horário não fica vazio',
    descricao:
      'A vaga das 14h vai para três pessoas da lista de espera ao mesmo tempo. A primeira que aceitar fica com ela.',
    executar: async (api) => {
      const vaga = emHoje('14:00', 1);
      const plano = planoDaVaga(vaga);

      api.ajustar((e) => {
        const cancelada = mudarStatus(e, 't3', 'cancelado');
        const ofertada = ['w1', 'w2', 'w3'].reduce(
          (acc, id) => mudarEspera(acc, id, 'ofertado'),
          cancelada,
        );
        return { ...ofertada, aba: 'fila', dia: 'amanha', conversaAtiva: 'mariana' };
      });

      if (!plano.ofertar) {
        api.avisar('Em cima da hora: não dá para oferecer a vaga com tão pouca antecedência.');
        return;
      }

      api.avisar(
        `Oferta para ${String(plano.quantos)} pessoas, válida até ${hhmm(plano.expiraEm)}.`,
      );
      await api.esperar(700);

      api.ajustar((e) =>
        comBotoes(
          comMensagem(
            e,
            'mariana',
            daClinica(
              'Oi, Mariana. Abriu um horário com a Dra. Ana amanhã, quarta, às 14:00, para a toxina botulínica.\nQuer ficar com ele?',
              '14:05',
            ),
          ),
          'mariana',
          [
            {
              rotulo: 'Quero este horário',
              aoTocar: async (a) => {
                const preco = PROCEDIMENTOS['botox']?.precoCentavos ?? 0;
                a.ajustar((e) => {
                  const comResposta = comMensagem(
                    e,
                    'mariana',
                    doPaciente('Quero este horário', '14:06'),
                  );
                  const ganhou = mudarEspera(comResposta, 'w1', 'atendido');
                  const perderam = ['w2', 'w3'].reduce(
                    (acc, id) => mudarEspera(acc, id, 'preenchido_por_outro'),
                    ganhou,
                  );
                  return comDecisao(
                    semDecisao(
                      {
                        ...perderam,
                        aba: 'dia',
                        selecionada: 't9',
                        recuperadoCentavos: perderam.recuperadoCentavos + preco,
                        consultas: [
                          ...perderam.consultas,
                          {
                            id: 't9',
                            dia: 'amanha',
                            profissionalId: 'ana',
                            horaAgendada: '14:00',
                            paciente: 'Mariana Teixeira',
                            procedimentoId: 'botox',
                            status: 'confirmado',
                            origem: 'lista_espera',
                          },
                        ],
                      },
                      'vaga-14h',
                    ),
                    {
                      id: 'vaga-preenchida',
                      severidade: 'ok',
                      titulo: 'Amanhã 14:00 preenchido por Mariana Teixeira',
                      detalhe:
                        'Veio da lista de espera em um minuto. João e Isabela foram avisados e continuam na fila.',
                    },
                  );
                });
                await a.esperar(600);
                a.ajustar((e) =>
                  comMensagem(
                    e,
                    'mariana',
                    daClinica(
                      'Pronto, Mariana. Está confirmado para amanhã às 14:00 com a Dra. Ana. Mando um lembrete antes.',
                      '14:06',
                    ),
                  ),
                );
                a.avisar(`${brl(preco)} que iam ficar na mesa.`);
              },
            },
            {
              rotulo: 'Não posso',
              aoTocar: (a) => {
                a.ajustar((e) => comMensagem(e, 'mariana', doPaciente('Não posso', '14:06')));
              },
            },
          ],
        ),
      );
    },
  },

  {
    titulo: 'Atendimento às 22h',
    descricao:
      'Um paciente novo pergunta preço e horário fora do expediente. A assistente responde com a tabela da clínica e só oferece horários livres.',
    executar: async (api) => {
      api.ajustar((e) => ({ ...e, aba: 'conversas', conversaAtiva: 'rodrigo' }));
      api.ajustar((e) =>
        comMensagem(
          e,
          'rodrigo',
          doPaciente('Boa noite! Quanto custa uma limpeza? Tem horário quinta de manhã?', '22:14'),
        ),
      );
      await api.esperar(700);

      const limpeza = PROCEDIMENTOS['limpeza'];
      api.ajustar((e) =>
        comMensagem(
          e,
          'rodrigo',
          daClinica(
            `Boa noite, Rodrigo. A profilaxia com o Dr. Paulo custa ${brl(limpeza?.precoCentavos ?? 0)} e leva cerca de ${String(limpeza?.duracaoAgendaMin ?? 45)} minutos.`,
            '22:15',
          ),
        ),
      );
      await api.esperar(600);
      api.ajustar((e) =>
        comBotoes(
          comMensagem(
            e,
            'rodrigo',
            daClinica(
              'Na quinta de manhã tenho 8:30 ou 10:00. Se preferir, sexta às 9:00. Qual fica melhor?',
              '22:15',
            ),
          ),
          'rodrigo',
          [
            { rotulo: 'Quinta, 10:00', aoTocar: (a) => marcar(a, '10:00') },
            { rotulo: 'Quinta, 8:30', aoTocar: (a) => marcar(a, '08:30') },
            {
              rotulo: 'Estou falando com uma pessoa?',
              aoTocar: async (a) => {
                a.ajustar((e) =>
                  comMensagem(e, 'rodrigo', doPaciente('Estou falando com uma pessoa?', '22:16')),
                );
                await a.esperar(600);
                // A assistente diz a verdade. Fingir ser pessoa é o que não se faz.
                a.ajustar((e) =>
                  comBotoes(
                    comMensagem(
                      e,
                      'rodrigo',
                      daClinica(
                        `Sou a Assistente Fliqo da ${CLINICA.nome}. Se preferir falar com alguém da equipe, chamo agora mesmo.`,
                        '22:16',
                      ),
                    ),
                    'rodrigo',
                    [{ rotulo: 'Quinta, 10:00', aoTocar: (b) => marcar(b, '10:00') }],
                  ),
                );
              },
            },
          ],
        ),
      );
    },
  },

  {
    titulo: 'O atraso visível',
    descricao:
      'A Dra. Ana está atrasada. Veja os blocos se deslocarem na linha do dia. Quem está em casa recebe o novo horário; quem já chegou, a recepção atende.',
    executar: async (api) => {
      api.ajustar((e) => ({
        ...e,
        aba: 'dia',
        dia: 'hoje',
        selecionada: null,
        conversaAtiva: 'lucas',
      }));
      await api.esperar(700);

      api.ajustar((e) => {
        // Quem avisar e com que texto é decisão de decidirAvisos, não daqui.
        const avisos = avisosDoDia(e.consultas, 'ana');
        const previsao = previsaoDoDia(e.consultas, 'hoje', 'ana');
        let proximo = e;

        for (const aviso of avisos) {
          const consulta = e.consultas.find((c) => c.id === aviso.consultaId);
          if (!consulta) continue;

          if (aviso.para === 'recepcao') {
            const p = previsao.get(consulta.id);
            proximo = comDecisao(proximo, {
              id: `recepcao-${consulta.id}`,
              severidade: 'late',
              titulo: `Fale com ${consulta.paciente} na recepção`,
              detalhe: `Já chegou. Vai ser atendida por volta de ${p ? hhmm(p.inicioPrevisto) : '—'}. Ofereça água ou café e explique o atraso.`,
              acao: 'Feito',
            });
            continue;
          }

          if (aviso.tipo !== 'atraso') continue;
          proximo = comDecisao(proximo, {
            id: `atraso-${consulta.id}`,
            severidade: 'late',
            titulo: `Dra. Ana com cerca de ${String(aviso.atrasoMin)} min de atraso`,
            detalhe: `Avisado por mensagem: ${consulta.paciente} (novo horário ${hhmm(aviso.novoHorario)}). As consultas da tarde seguem no horário: o almoço absorve o atraso.`,
          });

          if (consulta.id === 'h5') {
            proximo = comBotoes(
              comMensagem(
                proximo,
                'lucas',
                daClinica(
                  `Oi, Lucas. A Dra. Ana está com cerca de ${String(aviso.atrasoMin)} minutos de atraso hoje.\nSe preferir, pode chegar às ${hhmm(aviso.novoHorario)} em vez de ${consulta.horaAgendada}. Pedimos desculpas.`,
                  '10:41',
                ),
              ),
              'lucas',
              [
                {
                  rotulo: `Chego às ${hhmm(aviso.novoHorario)}`,
                  aoTocar: (a) => {
                    a.ajustar((x) =>
                      comMensagem(
                        x,
                        'lucas',
                        doPaciente(`Chego às ${hhmm(aviso.novoHorario)}`, '10:42'),
                      ),
                    );
                    a.avisar('Lucas não vai esperar na recepção.');
                  },
                },
                {
                  rotulo: 'Prefiro remarcar',
                  aoTocar: async (a) => {
                    a.ajustar((x) =>
                      comMensagem(x, 'lucas', doPaciente('Prefiro remarcar', '10:42')),
                    );
                    await a.esperar(600);
                    a.ajustar((x) =>
                      comMensagem(
                        x,
                        'lucas',
                        daClinica(
                          'Sem problema e sem nenhuma taxa. Tenho quinta às 11:20 ou sexta às 16:00.',
                          '10:42',
                        ),
                      ),
                    );
                  },
                },
              ],
            );
          }
        }
        return proximo;
      });

      api.avisar('Paciente avisado antes de sair de casa.');
    },
  },

  {
    titulo: 'Quando precisa de gente',
    descricao:
      'Paciente irritado com uma cobrança. A assistente não tenta resolver: entrega para a recepção e fica em silêncio.',
    executar: async (api) => {
      api.ajustar((e) => ({ ...e, aba: 'conversas', conversaAtiva: 'helena' }));
      api.ajustar((e) =>
        comMensagem(
          e,
          'helena',
          daClinica(
            'Oi, Helena. O recibo do seu procedimento de ontem já está disponível.',
            '09:02',
          ),
        ),
      );
      await api.esperar(500);
      api.ajustar((e) =>
        comMensagem(
          e,
          'helena',
          doPaciente('Isso é um absurdo, fui cobrada duas vezes no cartão!', '09:10'),
        ),
      );
      await api.esperar(800);

      api.ajustar((e) =>
        comDecisao(
          comMensagem(comModo(e, 'helena', 'humano'), 'helena', {
            de: 'sistema',
            texto: 'assistente pausada · recepção notificada',
          }),
          {
            id: 'helena-humano',
            severidade: 'risk',
            titulo: 'Helena Castro precisa falar com alguém da equipe',
            detalhe:
              'Reclamação de cobrança em duplicidade. A assistente parou de responder nesta conversa.',
            acao: 'Assumir',
          },
        ),
      );
      api.avisar('A conversa foi para a recepção.');
    },
  },

  {
    titulo: 'O que o dono vê',
    descricao:
      'Quanto vai entrar de verdade, quanto as faltas custaram e por que a agenda atrasa. Preencha a calculadora com os números da clínica.',
    executar: (api) => {
      api.ajustar((e) => ({ ...e, aba: 'caixa' }));
    },
  },
];

async function marcar(api: ApiDeCena, hora: string): Promise<void> {
  api.ajustar((e) =>
    comMensagem(e, 'rodrigo', doPaciente(`Quinta, ${hora.replace(/^0/, '')}`, '22:16')),
  );
  await api.esperar(600);
  api.ajustar((e) =>
    comBotoes(
      comMensagem(
        e,
        'rodrigo',
        daClinica(
          `Marcado: profilaxia na quinta às ${hora} com o Dr. Paulo.\n${CLINICA.endereco}.\nPosso te mandar lembretes da consulta por aqui?`,
          '22:16',
        ),
      ),
      'rodrigo',
      [
        {
          rotulo: 'Pode sim',
          aoTocar: async (a) => {
            a.ajustar((e) => comMensagem(e, 'rodrigo', doPaciente('Pode sim', '22:17')));
            await a.esperar(500);
            a.ajustar((e) =>
              comMensagem(e, 'rodrigo', daClinica('Combinado. Até quinta.', '22:17')),
            );
            // O consentimento fica registrado com data e hora: é o que a LGPD pede.
            a.avisar('Autorização para lembretes registrada, com data e hora.');
          },
        },
      ],
    ),
  );
  api.avisar('Consulta marcada às 22h, sem ninguém da recepção.');
}
