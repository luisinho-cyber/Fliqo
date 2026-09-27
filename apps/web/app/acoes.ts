'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { chamarApi } from '../lib/api';
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
