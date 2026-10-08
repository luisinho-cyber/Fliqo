import { createServer, type Server } from 'node:http';

/**
 * As duas rotas HTTP do worker, e o que cada uma faz de fato.
 *
 * O que o Railway faz com elas, conferido na documentação dele: o healthcheck roda SÓ no
 * início do deploy, aceita qualquer 2xx, e serve para decidir se o deploy novo entra no ar.
 * Ele não roda de forma contínua e não reinicia nada. Quem reinicia é a política
 * `ON_FAILURE` do `railway.json`, e ela só age quando o processo SAI com erro.
 *
 * Daí a divisão:
 *
 *   * `/health` é o que o healthcheck pergunta — "o processo subiu?" — e responde 200 enquanto
 *     o processo vive;
 *   * `/estado` é o veredito de trabalho: laços batendo, envio saindo, a causa quando não.
 *
 * O que isto NÃO faz: um laço travado não reinicia o worker. O processo continua vivo, nada
 * sai, e o `/estado` diz `travado` para quem perguntar. Reinício de verdade com laço travado
 * exige que o worker saia com erro sozinho; isso não existe hoje. Quem avisa o operador é o
 * e-mail do vigia (vigia-de-operador.ts).
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
 * declarar travado o que está apenas lento é alarme falso, e alarme falso ensina
 * quem lê o `/estado` a ignorá-lo. Declarar travado alguns minutos depois não
 * perde nada além desses minutos.
 *
 * A assimetria fica mais séria no dia em que o worker passar a sair com erro
 * quando um laço travar (não existe hoje): aí esta janela vira o gatilho de
 * reinício, e travado falso passa a matar o worker no meio de um envio.
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
 * fora destes laços, e por isso uma resposta demorada não vira `travado`.
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
 * memória. O `/estado` não abre conexão: ele lê o que o laço mediu, e a idade da medida diz
 * se o laço parou de medir. Uma rota que consultasse o banco responderia sobre o banco, não
 * sobre o laço.
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
 * O que o `/estado` lê: os batimentos dos laços e a medida de entrega, num objeto só.
 *
 * O laço SE REGISTRA aqui (`registrarLaco`), em vez de o `index.ts` montar um mapa de
 * batimentos à mão. No mapa à mão, tirar uma chave não quebrava nada: o laço continuava
 * rodando e batendo, e o `/estado` simplesmente deixava de saber que ele existia — laço
 * travado sem nenhum sinal. Registrado por quem roda, não existe batimento fora do veredito.
 */
export interface SinaisDeSaude {
  batimentos: Record<string, Batimento>;
  entrega: Entrega;
}

export function criarSinaisDeSaude(): SinaisDeSaude {
  return { batimentos: {}, entrega: criarEntrega() };
}

/** Cria o batimento do laço JÁ registrado no veredito: é o único jeito de um laço ter batimento. */
export function registrarLaco(
  sinais: SinaisDeSaude,
  nome: string,
  agora: () => number = Date.now,
): Batimento {
  const batimento = criarBatimento(agora);
  sinais.batimentos[nome] = batimento;
  return batimento;
}

/**
 * Os três estados, e por que não são dois.
 *
 * `travado`: o laço parou de bater, e o processo não está fazendo o trabalho.
 * `degradado`: o laço bate, mas o trabalho não sai — número de clínica com token expirado é o
 * caso típico, persiste por horas, e reiniciar o worker não o resolveria.
 *
 * São problemas com condutas diferentes (olhar o processo × olhar a credencial da clínica), e
 * por isso o veredito os separa. Nenhuma plataforma age sobre eles: o `/estado` é lido por
 * quem pergunta.
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
  entrega: Entrega;
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

  const medida = entrada.entrega.ultima();
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

/**
 * O código HTTP de cada estado do `/estado`, para quem olhar só o código.
 *
 * `degradado` é 207 e não 503 porque o worker ESTÁ atendendo e trabalhando — o que falta é a
 * credencial de uma clínica —, e não 200 porque 200 é a afirmação de saúde que esta rota
 * existe para não fazer de graça. Nenhum dos três reinicia nada.
 */
export const CODIGO_POR_ESTADO: Record<EstadoDeSaude, number> = {
  verde: 200,
  degradado: 207,
  travado: 503,
};

export interface ConfigSaude {
  porta: number;
  /**
   * Obrigatório, e lido a cada pergunta: o laço que se registrar depois de o servidor subir
   * aparece no veredito seguinte. Opcional, o `index.ts` podia deixar de passá-lo e o
   * `/estado` responderia verde sem olhar laço nenhum. Assim, não compila.
   */
  sinais: SinaisDeSaude;
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
        ...cfg.sinais,
        ...(cfg.janelaMs === undefined ? {} : { janelaMs: cfg.janelaMs }),
      },
      agora(),
    );
    res.writeHead(CODIGO_POR_ESTADO[veredito.estado], { 'content-type': 'application/json' });
    res.end(JSON.stringify(veredito));
  }).listen(cfg.porta, '0.0.0.0');
}
