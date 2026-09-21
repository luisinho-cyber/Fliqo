import rateLimit from '@fastify/rate-limit';
import { comoConexaoDoBoss, conversas, numeros, pacientes, withClinic, type Db } from '@fliqo/db';
import { FILA_CONVERSA } from '@fliqo/db/fila';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { assinaturaConfere } from './assinatura';
import type { Config } from './config';
import { extrair, PayloadWebhook } from './payload';
import { registrarPainel } from './rotas/painel';

declare module 'fastify' {
  interface FastifyRequest {
    /** Corpo bruto, preservado para o HMAC. Nunca reconstruir a partir do JSON. */
    rawBody?: Buffer;
  }
}

export interface Dependencias {
  config: Config;
  db: Db;
  boss: PgBoss;
}

/** O que guardamos como corpo: texto, ou o payload do botão quando foi um clique. */
function corpoDe(m: { texto?: string; payloadBotao?: string }): string | undefined {
  return m.texto ?? m.payloadBotao;
}

/** Telefone em log vai mascarado: LGPD, e log não é lugar de dado de paciente. */
function mascarar(telefone: string): string {
  return telefone.length <= 6 ? '***' : `${telefone.slice(0, 5)}***${telefone.slice(-2)}`;
}

export function construirApp(dep: Dependencias): FastifyInstance {
  const { config, db, boss } = dep;

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // A Meta assina o corpo como enviou. Se um proxy reescrever, o hash não bate.
    bodyLimit: 2 * 1024 * 1024,
  });

  // Guarda o corpo bruto ANTES do parse. É este buffer que o HMAC usa.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, corpo, done) => {
    const buffer = Buffer.isBuffer(corpo) ? corpo : Buffer.from(corpo);
    req.rawBody = buffer;
    if (buffer.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(buffer.toString('utf8')) as unknown);
    } catch {
      // Corpo inválido não é erro nosso: a rota decide o que responder.
      done(null, undefined);
    }
  });

  app.register(async (instancia) => {
    await instancia.register(rateLimit, { global: false });

    instancia.get('/health', () => ({ ok: true }));

    // Painel: limite por usuário, não por IP — uma clínica inteira costuma sair do
    // mesmo endereço, e limitar por IP puniria a recepção junto com o abuso.
    await instancia.register(async (painel) => {
      await painel.register(rateLimit, {
        max: 300,
        timeWindow: '1 minute',
        keyGenerator: (req) => {
          const auth = req.headers.authorization;
          return typeof auth === 'string' ? auth.slice(-32) : req.ip;
        },
      });
      registrarPainel(painel, {
        db,
        segredoJwt: new TextEncoder().encode(config.SUPABASE_JWT_SECRET),
      });
    });

    // Verificação da Meta: ela chama uma vez ao cadastrar o webhook.
    instancia.get('/webhooks/whatsapp', {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      handler: (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        if (
          q['hub.mode'] === 'subscribe' &&
          q['hub.verify_token'] === config.WHATSAPP_VERIFY_TOKEN
        ) {
          return reply.type('text/plain').send(q['hub.challenge'] ?? '');
        }
        return reply.code(403).send({ erro: 'verificacao_recusada' });
      },
    });

    instancia.post('/webhooks/whatsapp', {
      // Por IP: a Meta manda de poucos endereços, e isto é contra abuso de quem
      // descobrir a URL — não contra a Meta.
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      handler: async (req, reply) => {
        const bruto = req.rawBody;
        if (
          bruto === undefined ||
          !assinaturaConfere(bruto, req.headers['x-hub-signature-256'], config.WHATSAPP_APP_SECRET)
        ) {
          // 401 também quando o cabeçalho falta: não contamos ao atacante em
          // que etapa ele parou.
          return reply.code(401).send({ erro: 'assinatura_invalida' });
        }

        const payload = PayloadWebhook.safeParse(req.body);
        if (!payload.success) {
          req.log.warn('webhook com formato desconhecido');
          return reply.code(200).send({ ok: true });
        }

        for (const lote of extrair(payload.data)) {
          const clinicId = await numeros.clinicaDoNumero(db, lote.phoneNumberId);
          if (clinicId === undefined) {
            req.log.warn(
              { phoneNumberId: lote.phoneNumberId },
              'número não pertence a nenhuma clínica',
            );
            continue;
          }

          for (const m of lote.mensagens) {
            await withClinic(
              clinicId,
              async (trx) => {
                const achado = await pacientes.acharOuCriarPorTelefone(trx, clinicId, m.telefone);
                if (!achado.ok) {
                  // Número que não dá para salvar: registra e segue, sem derrubar o lote.
                  req.log.warn({ clinicId, motivo: achado.motivo }, 'telefone recusado');
                  return;
                }
                const paciente = achado.paciente;
                const conversa = await conversas.acharOuCriarPorPaciente(
                  trx,
                  clinicId,
                  paciente.id,
                );
                const corpo = corpoDe(m);
                const { novo } = await conversas.registrar(trx, {
                  conversaId: conversa.id,
                  clinicId,
                  direcao: 'entrada',
                  autor: 'paciente',
                  wamid: m.wamid,
                  // Resposta de botão guarda o payload fixo, não o rótulo: é ele
                  // que interpretarResposta() de packages/core entende.
                  ...(corpo === undefined ? {} : { corpo }),
                  ...(m.tipoMidia === undefined ? {} : { tipoMidia: m.tipoMidia }),
                });

                // Evento repetido da Meta: já gravamos e já enfileiramos antes.
                // Responder 200 sem refazer nada é o comportamento correto.
                if (!novo) {
                  req.log.info(
                    { clinicId, conversaId: conversa.id },
                    'mensagem repetida, ignorada',
                  );
                  return;
                }

                await conversas.marcarEntrada(trx, conversa.id, new Date());

                // Enfileira na MESMA transação: ou a mensagem e o job existem, ou nenhum dos dois.
                await boss.send({
                  name: FILA_CONVERSA,
                  data: { conversationId: conversa.id, clinicId },
                  options: { singletonKey: conversa.id, db: comoConexaoDoBoss(trx) },
                });

                req.log.info(
                  { clinicId, conversaId: conversa.id, telefone: mascarar(paciente.phone_e164) },
                  'mensagem recebida e enfileirada',
                );
              },
              db,
            );
          }
        }

        return reply.code(200).send({ ok: true });
      },
    });
  });

  return app;
}
