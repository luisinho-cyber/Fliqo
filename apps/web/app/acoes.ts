'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { chamarApi } from '../lib/api';
import type { RelatorioDaImportacao, SaidaDaImportacao } from '../lib/tipos';
import { criarClienteSupabase, emProducao, opcoesDoCookie } from '../lib/sessao';
import { clinicaEscolhida, COOKIE_DA_CLINICA, tokenDaSessao } from '../lib/servidor';

/**
 * As ações do painel. Todas no servidor: o navegador não tem token, não tem
 * chave e não fala com o Supabase nem com o banco.
 */

/** FormData devolve string ou arquivo; campo de texto que virou arquivo é lixo. */
function texto(valor: FormDataEntryValue | null): string {
  return typeof valor === 'string' ? valor : '';
}

async function clienteQueGrava() {
  const loja = await cookies();
  return criarClienteSupabase({
    ler: () => loja.getAll().map((c) => ({ name: c.name, value: c.value })),
    gravar: (cookies) => {
      for (const c of cookies) loja.set(c.name, c.value, c.options);
    },
  });
}

export async function entrar(formulario: FormData): Promise<void> {
  const email = texto(formulario.get('email')).trim();
  const senha = texto(formulario.get('senha'));
  if (email === '' || senha === '') redirect('/login?erro=faltou');

  const supabase = await clienteQueGrava();
  const { error } = await supabase.auth.signInWithPassword({ email, password: senha });
  // Uma mensagem só para e-mail errado e senha errada: dizer qual dos dois
  // estava certo conta a um estranho que aquele e-mail tem conta aqui.
  if (error) redirect('/login?erro=credenciais');

  redirect('/hoje');
}

export async function sair(): Promise<void> {
  const supabase = await clienteQueGrava();
  await supabase.auth.signOut();

  // A clínica escolhida vai junto: sessão nova começa sem nada do dono anterior.
  const loja = await cookies();
  loja.set(COOKIE_DA_CLINICA, '', { ...opcoesDoCookie(emProducao()), maxAge: 0 });

  redirect('/login');
}

export async function escolherClinica(formulario: FormData): Promise<void> {
  const id = texto(formulario.get('clinica'));
  const loja = await cookies();
  loja.set(COOKIE_DA_CLINICA, id, opcoesDoCookie(emProducao()));
  redirect('/hoje');
}

export async function resolverDecisao(formulario: FormData): Promise<void> {
  const id = texto(formulario.get('decisao'));
  const token = await tokenDaSessao();
  if (token === undefined) redirect('/login');

  const clinicaId = await clinicaEscolhida();
  await chamarApi(`/api/alertas/${id}/resolver`, {
    token,
    metodo: 'POST',
    ...(clinicaId === undefined ? {} : { clinicaId }),
  });
  revalidatePath('/hoje');
}

/** Os três toques da tela Hoje. Um por consulta, sem formulário. */
export async function tocar(formulario: FormData): Promise<void> {
  const id = texto(formulario.get('consulta'));
  const toque = texto(formulario.get('toque'));
  if (!['chegou', 'iniciar', 'finalizar'].includes(toque)) return;

  await naApi(`/api/agenda/${id}/${toque}`);
  // A Linha do Dia e a régua de atraso voltam recalculadas na mesma resposta:
  // quem tocou não precisa recarregar nada.
  revalidatePath('/hoje');
}

export async function assumirConversa(formulario: FormData): Promise<void> {
  const id = texto(formulario.get('conversa'));
  await naApi(`/api/conversas/${id}/assumir`);
  revalidatePath(`/conversas/${id}`);
  revalidatePath('/conversas');
}

export async function devolverConversa(formulario: FormData): Promise<void> {
  const id = texto(formulario.get('conversa'));
  await naApi(`/api/conversas/${id}/devolver`);
  revalidatePath(`/conversas/${id}`);
  revalidatePath('/conversas');
}

export async function salvarQualificacao(formulario: FormData): Promise<void> {
  const id = texto(formulario.get('conversa'));
  const faixa = texto(formulario.get('faixaDeOrcamento'));
  await naApi(`/api/conversas/${id}/qualificacao`, {
    interesse: texto(formulario.get('interesse')) || null,
    faixaDeOrcamento: faixa === '' ? null : faixa,
    observacao: texto(formulario.get('observacao')) || null,
  });
  revalidatePath(`/conversas/${id}`);
}

export async function remarcar(formulario: FormData): Promise<void> {
  const id = texto(formulario.get('consulta'));
  const novoInicio = texto(formulario.get('novoInicio'));
  const r = await naApi(`/api/agenda/${id}/remarcar`, { novoInicio });

  // 409 é resposta de negócio, não erro: alguém marcou aquele horário no
  // intervalo entre a tela carregar e o arraste terminar. A consulta original
  // fica intacta, e a tela diz isso em português.
  const aviso = r.ok ? '' : '?aviso=horario_ocupado';
  revalidatePath('/agenda');
  if (aviso !== '') redirect(`/agenda${aviso}`);
}

export async function oferecerVaga(formulario: FormData): Promise<void> {
  await naApi('/api/fila/oferecer', {
    profissionalId: texto(formulario.get('profissionalId')),
    inicio: texto(formulario.get('inicio')),
    fim: texto(formulario.get('fim')),
  });
  redirect('/agenda?aviso=oferta_enviada');
}

/**
 * Importar a agenda do outro sistema.
 *
 * Recebe argumentos, não FormData, porque quem chama é o componente de cliente que
 * leu o arquivo. O texto do arquivo vai para a NOSSA API, que é quem separa os
 * campos de verdade e grava dentro da RLS — o palpite de colunas do navegador é
 * conveniência, não autoridade.
 */
export async function importarAgenda(pedido: {
  arquivo: string;
  texto: string;
  mapa: {
    paciente: number;
    telefone: number;
    profissional: number;
    inicio: number;
    procedimento: number;
  };
  temCabecalho: boolean;
}): Promise<{ ok: true; relatorio: RelatorioDaImportacao } | { ok: false; erro: string }> {
  const r = await naApi<SaidaDaImportacao>('/api/importacoes', pedido);
  revalidatePath('/importar');
  // A agenda mudou em lote: a Linha do Dia e a semana precisam ser relidas.
  revalidatePath('/hoje');
  revalidatePath('/agenda');
  // 403 é a única recusa de autorização; planilha vazia ou grande demais chegam
  // como falha esperada no corpo, com motivo, porque a clínica precisa saber o quê.
  if (!r.ok) {
    return {
      ok: false,
      erro: r.motivo === 'sem_acesso' ? 'apenas_dono_importa_agenda' : 'indisponivel',
    };
  }
  return r.dados.ok
    ? { ok: true, relatorio: r.dados.relatorio }
    : { ok: false, erro: r.dados.motivo };
}

/** Um POST na nossa API, já com o portador e a clínica da sessão. */
async function naApi<T = unknown>(caminho: string, corpo?: unknown) {
  const token = await tokenDaSessao();
  if (token === undefined) redirect('/login?erro=sessao');
  const clinicaId = await clinicaEscolhida();
  return chamarApi<T>(caminho, {
    token,
    metodo: 'POST',
    ...(clinicaId === undefined ? {} : { clinicaId }),
    ...(corpo === undefined ? {} : { corpo }),
  });
}

/**
 * Remarcar pelo arraste. Recebe argumentos, não FormData, porque quem chama é
 * o componente de cliente da grade — o formulário abaixo dela usa `remarcar`.
 */
export async function remarcarPorArraste(consultaId: string, novoInicio: string): Promise<void> {
  const r = await naApi(`/api/agenda/${consultaId}/remarcar`, { novoInicio });
  revalidatePath('/agenda');
  if (!r.ok) redirect('/agenda?aviso=horario_ocupado');
}

/**
 * Conectar e reconectar o WhatsApp da clínica.
 *
 * Recebe o código que o SDK da Meta entregou ao navegador, e só ele: o token
 * nunca passa pelo navegador nem por aqui. Quem troca o código por token é a
 * nossa API, que é onde o segredo do app mora.
 *
 * Recebe argumentos, não FormData, porque quem chama é o componente de cliente
 * que abriu o fluxo da Meta.
 */
export async function conectarWhatsapp(
  codigo: string,
  pin: string,
  reconectar: boolean,
): Promise<{ ok: boolean; erro?: string }> {
  const caminho = reconectar ? '/api/whatsapp/reconectar' : '/api/whatsapp/conectar';
  const r = await naApi(caminho, { codigo, pin, coexistencia: true });
  revalidatePath('/configuracoes/whatsapp');
  // A mensagem que chega à clínica é escolhida aqui, e não ecoada da Meta:
  // texto de fora pode trazer segredo dentro.
  if (r.ok) return { ok: true };
  return { ok: false, erro: 'nao_conectou' };
}

export async function desconectarWhatsapp(): Promise<void> {
  await naApi('/api/whatsapp/desconectar');
  revalidatePath('/configuracoes/whatsapp');
}
