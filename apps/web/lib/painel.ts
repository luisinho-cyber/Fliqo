import { redirect } from 'next/navigation';
import { chamarApi, type Resposta } from './api';
import { clinicaEscolhida, tokenDaSessao } from './servidor';
import type { ClinicaDaPessoa } from './tipos';

/**
 * O começo de toda tela do painel: sessão, clínica e o primeiro GET.
 *
 * Existe para as três telas não repetirem — e repetirem errado — a decisão de
 * quando mandar alguém para o login. 401 da API quer dizer "a sessão acabou",
 * não "deu erro": quem perdeu só a rede não pode ser deslogado.
 */
export interface Contexto {
  token: string;
  clinica: ClinicaDaPessoa;
  clinicas: ClinicaDaPessoa[];
}

export type Entrada =
  { ok: true; ctx: Contexto } | { ok: false; motivo: 'sem_clinica' | 'indisponivel' };

export async function entrarNoPainel(): Promise<Entrada> {
  const token = await tokenDaSessao();
  if (token === undefined) redirect('/login?erro=sessao');

  const clinicas = await chamarApi<ClinicaDaPessoa[]>('/api/minhas-clinicas', { token });
  if (!clinicas.ok) {
    if (clinicas.motivo === 'sem_sessao') redirect('/login?erro=sessao');
    return { ok: false, motivo: 'indisponivel' };
  }
  if (clinicas.dados.length === 0) return { ok: false, motivo: 'sem_clinica' };

  const pedida = await clinicaEscolhida();
  // A clínica do cookie só vale se ainda estiver na lista: quem saiu de uma
  // clínica não continua vendo a agenda dela por causa de um cookie velho.
  const clinica = clinicas.dados.find((x) => x.id === pedida) ?? clinicas.dados[0];
  if (clinica === undefined) return { ok: false, motivo: 'sem_clinica' };

  return { ok: true, ctx: { token, clinica, clinicas: clinicas.dados } };
}

/** Um GET da tela, já com o portador e a clínica. 401 manda para o login. */
export async function buscar<T>(ctx: Contexto, caminho: string): Promise<Resposta<T>> {
  const r = await chamarApi<T>(caminho, { token: ctx.token, clinicaId: ctx.clinica.id });
  if (!r.ok && r.motivo === 'sem_sessao') redirect('/login?erro=sessao');
  return r;
}
