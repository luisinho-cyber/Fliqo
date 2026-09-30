import { createServer, type Server } from 'node:http';

/**
 * O health check do worker.
 *
 * O worker não atendia HTTP, e por isso o Railway não tinha como saber se ele
 * estava vivo. Worker morto em silêncio é o pior caso deste produto: ninguém é
 * confirmado, nenhuma vaga é oferecida, e nada avisa.
 *
 * O que importa é o que ele RESPONDE. Um `/health` que devolve 200 porque o
 * processo existe é pior do que não ter health check: ele afirma saúde enquanto o
 * laço está travado. Aqui o veredito vem das batidas de vida dos laços.
 */

export interface Batimento {
  marcar: () => void;
  ultimo: () => number;
}

export function criarBatimento(agora: () => number = Date.now): Batimento {
  // Começa vivo: o processo acabou de subir e ainda não teve chance de bater.
  let ultimo = agora();
  return {
    marcar: () => {
      ultimo = agora();
    },
    ultimo: () => ultimo,
  };
}

/**
 * Quanto tempo sem batida antes de declarar o laço travado.
 *
 * O número é DERIVADO DA PIOR VOLTA PLAUSÍVEL, não do intervalo nominal — e é
 * generoso de propósito, porque o custo de errar para cada lado é assimétrico:
 * declarar travado o que está apenas lento faz o Railway reiniciar o worker no
 * meio do trabalho, e aí uma resposta de paciente se perde. Esperar alguns
 * minutos a mais para reiniciar um worker de fato travado não perde nada além
 * desses minutos.
 *
 * A conta, para quem vier apertar este número depois:
 *
 * - a batida é marcada a cada AÇÃO concluída, não ao fim da rodada, então a
 *   janela cobre uma ação só, e não as cinquenta da rodada;
 * - um envio tenta 4 vezes, com 0,5 s + 2 s + 8 s de espera entre elas, mais o
 *   ritmo do limitador por número;
 * - **nenhuma dessas tentativas tem timeout de socket** (ver `#tentar` em
 *   `packages/whatsapp/src/meta.ts`): o teto real de uma tentativa presa é o do
 *   sistema operacional, na casa dos dois minutos;
 * - somando a espera entre voltas do laço mais lento (2 min), a maior lacuna
 *   legítima entre batidas fica perto de 4 min.
 *
 * Dez minutos são esses 4 min com folga de mais que o dobro. **A folga não é
 * conservadorismo: ela existe porque o teto de uma tentativa presa não é nosso.**
 * No dia em que o cliente da Meta ganhar timeout explícito, esta janela pode cair
 * — e só nesse dia.
 *
 * O que NÃO entra na conta: a conversa da assistente. Ela roda como job da fila,
 * fora destes laços, e por isso uma resposta demorada não derruba o serviço.
 */
export const JANELA_DE_SAUDE_MS = 10 * 60_000;

export interface VereditoDeSaude {
  ok: boolean;
  lacos: Record<string, { ultimaBatidaMs: number; travado: boolean }>;
}

/** Função pura: o servidor só traduz isto em código HTTP. */
export function vereditoDeSaude(
  batimentos: Record<string, Batimento>,
  agoraMs: number,
  janelaMs: number = JANELA_DE_SAUDE_MS,
): VereditoDeSaude {
  const lacos: VereditoDeSaude['lacos'] = {};
  let ok = true;
  for (const [nome, batimento] of Object.entries(batimentos)) {
    const idade = agoraMs - batimento.ultimo();
    const travado = idade > janelaMs;
    if (travado) ok = false;
    lacos[nome] = { ultimaBatidaMs: idade, travado };
  }
  return { ok, lacos };
}

export interface ConfigSaude {
  porta: number;
  batimentos: Record<string, Batimento>;
  janelaMs?: number;
  agora?: () => number;
}

/**
 * Servidor mínimo, com `node:http` e sem dependência nova: o worker não serve
 * página nenhuma, e puxar um framework para responder uma rota seria peso sem uso.
 */
export function servidorDeSaude(cfg: ConfigSaude): Server {
  const agora = cfg.agora ?? Date.now;
  return createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"erro":"nao_encontrado"}');
      return;
    }
    const veredito = vereditoDeSaude(cfg.batimentos, agora(), cfg.janelaMs);
    res.writeHead(veredito.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(veredito));
  }).listen(cfg.porta, '0.0.0.0');
}
