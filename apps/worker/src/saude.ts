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

/**
 * A medida de ENTREGA, separada do batimento.
 *
 * Existe porque o batimento sozinho anda na direção contrária do problema. Ele é marcado a
 * cada ação concluída e a cada volta do laço — então uma clínica com o número em erro, cujas
 * ações o `claim_due_actions` deixa de reclamar, produz rodadas que terminam limpas, rápidas,
 * e com o batimento batendo. Suprimir o envio MELHORAVA o sinal.
 *
 * `vencidasRepresadas` é o contrapeso: ação de envio com prazo no passado que ainda está
 * `pendente`. Ela é medida pelo próprio laço que suprime, a cada volta, e guardada em
 * memória — o /health não abre conexão, porque um health check que depende do banco transforma
 * uma oscilação de rede em reinício de worker.
 */
export interface MedidaDeEntrega {
  vencidasRepresadas: number;
  /** Quando a medida foi tirada. Medida velha é tão suspeita quanto medida ruim. */
  emMs: number;
}

export interface Entrega {
  marcar: (vencidasRepresadas: number, agoraMs: number) => void;
  ultima: () => MedidaDeEntrega | undefined;
}

export function criarEntrega(): Entrega {
  let medida: MedidaDeEntrega | undefined;
  return {
    marcar: (vencidasRepresadas, emMs) => {
      medida = { vencidasRepresadas, emMs };
    },
    ultima: () => medida,
  };
}

/**
 * Os três estados, e por que não são dois.
 *
 * `travado` é "me reinicie": o laço parou de bater e o processo não está fazendo o trabalho.
 * `degradado` é "o trabalho não está saindo, e reiniciar NÃO resolve" — número de clínica com
 * token expirado é o caso típico, e ele persiste por horas.
 *
 * Misturar os dois em 503 seria pior do que o problema: a plataforma reiniciaria o worker em
 * laço enquanto uma clínica estivesse com a credencial vencida, e aí NENHUMA clínica receberia
 * mensagem para "consertar" a de uma. Por isso `degradado` responde 207, que é 2xx — o
 * processo continua vivo — e não 200, que é a afirmação de saúde que este arquivo existe para
 * deixar de fazer de graça.
 */
export type EstadoDeSaude = 'verde' | 'degradado' | 'travado';

export interface VereditoDeSaude {
  /** `true` só no verde. Mantido para quem já lia este campo. */
  ok: boolean;
  estado: EstadoDeSaude;
  /** Por que não está verde, em uma frase. `null` no verde: estado bom não precisa de causa. */
  causa: string | null;
  lacos: Record<string, { ultimaBatidaMs: number; travado: boolean }>;
  entrega: { vencidasRepresadas: number; idadeDaMedidaMs: number | null; represado: boolean };
}

export interface EntradaDoVeredito {
  batimentos: Record<string, Batimento>;
  entrega?: Entrega;
  janelaMs?: number;
}

/** Função pura: o servidor só traduz isto em código HTTP. */
export function vereditoDeSaude(entrada: EntradaDoVeredito, agoraMs: number): VereditoDeSaude {
  const janelaMs = entrada.janelaMs ?? JANELA_DE_SAUDE_MS;
  const lacos: VereditoDeSaude['lacos'] = {};
  let algumTravado = false;
  for (const [nome, batimento] of Object.entries(entrada.batimentos)) {
    const idade = agoraMs - batimento.ultimo();
    const travado = idade > janelaMs;
    if (travado) algumTravado = true;
    lacos[nome] = { ultimaBatidaMs: idade, travado };
  }

  const medida = entrada.entrega?.ultima();
  const idadeDaMedidaMs = medida === undefined ? null : agoraMs - medida.emMs;
  /*
   * Medida ausente ou velha NÃO é represamento: o worker acabou de subir e ainda não deu a
   * primeira volta. Tratá-la como ruim faria todo deploy nascer degradado, e aí ninguém
   * olharia o estado nunca mais.
   */
  const represado =
    medida !== undefined && idadeDaMedidaMs !== null && idadeDaMedidaMs <= janelaMs
      ? medida.vencidasRepresadas > 0
      : false;

  const estado: EstadoDeSaude = algumTravado ? 'travado' : represado ? 'degradado' : 'verde';

  return {
    ok: estado === 'verde',
    estado,
    causa: causaDoEstado(estado, lacos, medida?.vencidasRepresadas ?? 0),
    lacos,
    entrega: {
      vencidasRepresadas: medida?.vencidasRepresadas ?? 0,
      idadeDaMedidaMs,
      represado,
    },
  };
}

/**
 * A causa nomeia o laço e o número, e nada mais: o corpo é lido por quem tem a porta, e
 * "qual clínica" é pergunta do e-mail do vigia de operador, não desta rota.
 */
function causaDoEstado(
  estado: EstadoDeSaude,
  lacos: VereditoDeSaude['lacos'],
  vencidasRepresadas: number,
): string | null {
  if (estado === 'travado') {
    const parados = Object.entries(lacos)
      .filter(([, l]) => l.travado)
      .map(
        ([nome, l]) =>
          `"${nome}" sem batida há ${String(Math.floor(l.ultimaBatidaMs / 60_000))} min`,
      );
    return `laço parado: ${parados.join('; ')}`;
  }
  if (estado === 'degradado') {
    return `${String(vencidasRepresadas)} ação(ões) de envio vencida(s) que não saíram`;
  }
  return null;
}

/** O código HTTP de cada estado. 207 é 2xx: o processo não é reiniciado por estar degradado. */
export const CODIGO_POR_ESTADO: Record<EstadoDeSaude, number> = {
  verde: 200,
  degradado: 207,
  travado: 503,
};

export interface ConfigSaude {
  porta: number;
  batimentos: Record<string, Batimento>;
  /** A medida de entrega. Ausente, o veredito usa só os batimentos, como antes. */
  entrega?: Entrega;
  janelaMs?: number;
  agora?: () => number;
}

/**
 * Servidor mínimo, com `node:http` e sem dependência nova: o worker não serve
 * página nenhuma, e puxar um framework para responder duas rotas seria peso sem uso.
 *
 * As duas rotas respondem perguntas DIFERENTES, e misturá-las foi o que fez o /health mentir:
 *
 *   * `/health` — "o processo está de pé?". 200 enquanto ele vive. É o que o healthcheck do
 *     Railway pergunta no início do deploy, e por isso não consulta batimento nem entrega:
 *     liveness que sabe de entrega passa a responder outra coisa com o mesmo nome.
 *   * `/estado` — "o trabalho está saindo?". O veredito inteiro: estado, causa e números.
 *     Fica fora do healthcheck do Railway.
 */
export function servidorDeSaude(cfg: ConfigSaude): Server {
  const agora = cfg.agora ?? Date.now;
  return createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url !== '/estado') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"erro":"nao_encontrado"}');
      return;
    }
    const veredito = vereditoDeSaude(
      {
        batimentos: cfg.batimentos,
        ...(cfg.entrega === undefined ? {} : { entrega: cfg.entrega }),
        ...(cfg.janelaMs === undefined ? {} : { janelaMs: cfg.janelaMs }),
      },
      agora(),
    );
    res.writeHead(CODIGO_POR_ESTADO[veredito.estado], { 'content-type': 'application/json' });
    res.end(JSON.stringify(veredito));
  }).listen(cfg.porta, '0.0.0.0');
}
