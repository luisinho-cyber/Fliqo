/**
 * Os identificadores do cenário, fixos.
 *
 * Fixos e não gerados para o spec não precisar ler nenhum arquivo de estado que o
 * `global-setup` tenha escrito: o navegador assina o próprio token com o `USUARIO` daqui, e
 * é o mesmo que o seed pôs em `clinic_members`. Um arquivo de estado entre os dois seria
 * mais uma coisa capaz de ficar velha sem ninguém notar.
 *
 * Visivelmente de teste: nenhum destes valores existe fora desta máquina.
 */
export const CLINICA = 'e2ee2ee2-0000-4000-8000-000000000001';
export const USUARIO = 'e2ee2ee2-0000-4000-8000-000000000002';
export const PROFISSIONAL = 'e2ee2ee2-0000-4000-8000-000000000003';
export const PROCEDIMENTO = 'e2ee2ee2-0000-4000-8000-000000000004';
export const PACIENTE_CONFIRMADO = 'e2ee2ee2-0000-4000-8000-000000000005';
export const PACIENTE_SEM_CONFIRMAR = 'e2ee2ee2-0000-4000-8000-000000000006';

export const NOME_CONFIRMADO = 'Marta Ribeiro';
export const NOME_SEM_CONFIRMAR = 'Antônio Pires';

/**
 * A Linha do Dia mostra só o PRIMEIRO nome.
 *
 * É decisão de produto, não detalhe: a tela fica num monitor que o paciente da cadeira ao
 * lado vê. Fixado aqui porque o spec afirma o que a interface mostra, e um teste que
 * procurasse o nome inteiro falharia sem que nada estivesse errado.
 */
export const PRIMEIRO_CONFIRMADO = 'Marta';
export const PRIMEIRO_SEM_CONFIRMAR = 'Antônio';

/**
 * O cookie em que o @supabase/ssr guarda a sessão.
 *
 * O nome é derivado do host de SUPABASE_URL pelo supabase-js:
 * `sb-${hostname.split('.')[0]}-auth-token`. Com o Supabase falso em 127.0.0.1, dá `sb-127`.
 */
export const COOKIE_DA_SESSAO = 'sb-127-auth-token';
