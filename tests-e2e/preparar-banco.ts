import pg from 'pg';
import { ownerPool, prepararFilaDeTeste, resetDatabase, urlDoTester } from '@fliqo/db/testing';
import {
  CLINICA,
  NOME_CONFIRMADO,
  NOME_SEM_CONFIRMAR,
  PACIENTE_CONFIRMADO,
  PACIENTE_SEM_CONFIRMAR,
  PROCEDIMENTO,
  PROFISSIONAL,
  USUARIO,
} from './identidades';

/**
 * O banco do e2e de interface: migrado do zero e semeado com o dia de hoje.
 *
 * Roda ANTES do Playwright, e não como `globalSetup`, porque o Playwright sobe os
 * `webServer` primeiro e só então chama o setup — e `resetDatabase` derruba o banco, o que
 * matava a API que já havia conectado. A ordem certa é um passo próprio no script do npm.
 *
 * Roda com `DATABASE_ADMIN_URL` — é o único passo que precisa dela. A API e o painel sobem
 * com a variável apagada, porque `recusarAdminUrl` recusa subir com ela e esse guarda vale
 * aqui também.
 *
 * O cenário é o mínimo que a tela Hoje precisa para dizer alguma coisa: uma consulta
 * confirmada e uma sem confirmação, as duas hoje, com nome de paciente que não existe fora
 * desta máquina.
 */
export async function preparar(): Promise<void> {
  if (!process.env['DATABASE_ADMIN_URL']) {
    throw new Error(
      'o e2e do painel precisa de DATABASE_ADMIN_URL para migrar o banco de teste. ' +
        'Ela fica só neste passo: a API e o painel sobem sem ela.',
    );
  }

  await resetDatabase();
  // A API chama `boss.start()` ao subir, e sem o schema da fila ela não sobe.
  await prepararFilaDeTeste();

  /*
   * A CLÍNICA nasce pelo dono do schema, e não é atalho: a política de `app.clinics` é
   * `id = app.clinic_id()`, e numa política FOR ALL sem WITH CHECK o Postgres usa o USING
   * também como check de INSERT. Ou seja, o papel da aplicação não consegue criar clínica
   * nenhuma — por desenho. Quem cria é o onboarding da Fase 7, por um caminho privilegiado.
   */
  const dono = ownerPool();
  try {
    await dono.query(
      `insert into app.clinics (id, name, timezone) values ($1, 'Clínica do E2E', 'America/Sao_Paulo')`,
      [CLINICA],
    );
  } finally {
    await dono.end();
  }

  const banco = new pg.Client({ connectionString: urlDoTester() });
  await banco.connect();
  try {
    /*
     * O RESTO é escrito como `fliqo_tester`, que herda `fliqo_app` — ou seja, PASSANDO pela
     * RLS, com `app.clinic_id` configurado. Semear tudo como dono do schema seria semear por
     * um caminho que a aplicação não tem, e esconderia uma política mal escrita.
     */
    await banco.query('begin');
    await banco.query(`select set_config('app.clinic_id', $1, true)`, [CLINICA]);

    await banco.query(
      `insert into app.clinic_members (clinic_id, user_id, role) values ($1, $2, 'dono')`,
      [CLINICA, USUARIO],
    );
    await banco.query(
      `insert into app.professionals (id, clinic_id, name) values ($1, $2, 'Dra. Helena')`,
      [PROFISSIONAL, CLINICA],
    );
    await banco.query(
      `insert into app.procedures (id, clinic_id, name, duration_minutes, price_cents)
       values ($1, $2, 'Limpeza e profilaxia', 45, 18000)`,
      [PROCEDIMENTO, CLINICA],
    );
    for (const [id, nome, telefone] of [
      [PACIENTE_CONFIRMADO, NOME_CONFIRMADO, '+5511900000001'],
      [PACIENTE_SEM_CONFIRMAR, NOME_SEM_CONFIRMAR, '+5511900000002'],
    ] as const) {
      await banco.query(
        `insert into app.patients (id, clinic_id, name, phone_e164, whatsapp_consent_at)
         values ($1, $2, $3, $4, now())`,
        [id, CLINICA, nome, telefone],
      );
    }

    /*
     * Duas consultas HOJE, em horas diferentes para não colidirem no `no_double_booking`.
     * `date_trunc('day', now())` no fuso da sessão é suficiente: o que a tela precisa é que
     * as duas caiam no dia corrente, e o teste não afirma hora nenhuma.
     */
    await banco.query(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
          price_cents, status, confirmed_at)
       values
         ($1, $2, $3, $4, date_trunc('day', now()) + interval '14 hours',
          date_trunc('day', now()) + interval '14 hours 45 minutes', 18000, 'confirmado', now()),
         ($1, $2, $5, $4, date_trunc('day', now()) + interval '16 hours',
          date_trunc('day', now()) + interval '16 hours 45 minutes', 18000, 'agendado', null)`,
      [CLINICA, PROFISSIONAL, PACIENTE_CONFIRMADO, PROCEDIMENTO, PACIENTE_SEM_CONFIRMAR],
    );
    await banco.query('commit');
  } catch (erro) {
    await banco.query('rollback');
    throw erro;
  } finally {
    await banco.end();
  }
}

await preparar();
