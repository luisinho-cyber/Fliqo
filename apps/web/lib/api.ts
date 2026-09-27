/**
 * O cliente da nossa API.
 *
 * O painel fala SÓ com a nossa API — é ela que abre `withClinic` e passa pela
 * RLS (CLAUDE.md, regra 10). Nada de ler tabela pelo navegador.
 *
 * Quem valida o token continua sendo a API, do lado servidor. Aqui só se
 * carrega o portador e se traduz o que ela respondeu: 401 quer dizer "a sessão
 * acabou, volte para o login", e não "deu erro".
 *
 * O token nunca aparece em mensagem de erro nem em log. Ele entra no cabeçalho
 * e para por aí.
 */

export type MotivoDeFalha = 'sem_sessao' | 'sem_acesso' | 'indisponivel';

export type Resposta<T> = { ok: true; dados: T } | { ok: false; motivo: MotivoDeFalha };

export interface Chamada {
  token: string;
  clinicaId?: string;
  metodo?: 'GET' | 'POST';
  /** Corpo do pedido. Vai como JSON; nunca entra em log nem em erro. */
  corpo?: unknown;
  /** Injetável no teste: a API de verdade exige servidor do outro lado. */
  buscar?: typeof fetch;
  sinal?: AbortSignal;
}

export function enderecoDaApi(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.API_URL;
  if (!url) throw new Error('configuração inválida: API_URL é obrigatório');
  return url.replace(/\/$/, '');
}

export async function chamarApi<T>(
  caminho: string,
  chamada: Chamada,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Resposta<T>> {
  const buscar = chamada.buscar ?? fetch;
  // Fora do try: subir sem API_URL é bug de configuração, e tem que estourar —
  // virar "indisponível" esconderia o problema atrás de uma tela de erro.
  const endereco = `${enderecoDaApi(env)}${caminho}`;

  let resposta: Response;
  try {
    resposta = await buscar(endereco, {
      method: chamada.metodo ?? 'GET',
      headers: {
        authorization: `Bearer ${chamada.token}`,
        ...(chamada.clinicaId === undefined ? {} : { 'x-clinica': chamada.clinicaId }),
        ...(chamada.corpo === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(chamada.corpo === undefined ? {} : { body: JSON.stringify(chamada.corpo) }),
      // A tela Hoje é o agora: uma resposta guardada mostraria um atraso que já passou.
      cache: 'no-store',
      ...(chamada.sinal === undefined ? {} : { signal: chamada.sinal }),
    });
  } catch {
    // Rede caiu, API fora do ar: a tela tem um estado para isso, escrito à mão.
    return { ok: false, motivo: 'indisponivel' };
  }

  if (resposta.status === 401) return { ok: false, motivo: 'sem_sessao' };
  if (resposta.status === 403) return { ok: false, motivo: 'sem_acesso' };
  if (!resposta.ok) return { ok: false, motivo: 'indisponivel' };

  try {
    return { ok: true, dados: (await resposta.json()) as T };
  } catch {
    return { ok: false, motivo: 'indisponivel' };
  }
}
