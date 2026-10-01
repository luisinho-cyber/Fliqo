import { assertCents } from '@fliqo/core';
import { sql } from 'kysely';
import type { Db } from '../conexao';
import type { StatusConsulta } from '../schema';
import type { Trx } from '../withClinic';

/**
 * As leituras da tela Hoje.
 *
 * Uma consulta só para a faixa do dia: a tela precisa do nome do paciente e do
 * procedimento junto com a consulta, e três idas ao banco por linha é o jeito
 * de a tela ficar lenta com a agenda cheia.
 */

/**
 * As clínicas de quem acabou de entrar.
 *
 * Roda FORA de withClinic — é a pergunta que vem antes de haver clínica, como
 * `numeros.clinicaDoNumero`. O `userId` é o `sub` do JWT já verificado pela API;
 * nunca o que o navegador mandou.
 */
export async function clinicasDoUsuario(db: Db, userId: string): Promise<string[]> {
  const r = await sql<{ clinic_id: string }>`
    select app.clinic_ids_of_member(${userId}::uuid) as clinic_id
  `.execute(db);
  return r.rows.map((l) => l.clinic_id);
}

export interface DadosDaClinica {
  id: string;
  nome: string;
  fuso: string;
  /** Modo convidado (0012): a agenda vive em outro sistema e a Fliqo opera sobre ela. */
  modoConvidado: boolean;
}

/** Nome e fuso vêm de dentro da RLS: a função de fora devolve só o id. */
export async function dadosDaClinica(trx: Trx, clinicId: string): Promise<DadosDaClinica> {
  const c = await trx
    .selectFrom('app.clinics')
    .select(['id', 'name', 'timezone', 'guest_mode'])
    .where('id', '=', clinicId)
    .executeTakeFirstOrThrow();
  return { id: c.id, nome: c.name, fuso: c.timezone, modoConvidado: c.guest_mode };
}

export interface ConsultaDaTela {
  id: string;
  professional_id: string;
  patient_id: string;
  procedure_id: string;
  paciente: string;
  procedimento: string;
  starts_at: Date;
  ends_at: Date;
  status: StatusConsulta;
  price_cents: number;
  checked_in_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  duracao_agenda_min: number;
}

export async function agendaDoDia(trx: Trx, de: Date, ate: Date): Promise<ConsultaDaTela[]> {
  const linhas = await trx
    .selectFrom('app.appointments as a')
    .innerJoin('app.procedures as p', 'p.id', 'a.procedure_id')
    .innerJoin('app.patients as pac', 'pac.id', 'a.patient_id')
    .select([
      'a.id',
      'a.professional_id',
      'a.patient_id',
      'a.procedure_id',
      'pac.name as paciente',
      'p.name as procedimento',
      'a.starts_at',
      'a.ends_at',
      'a.status',
      'a.price_cents',
      'a.checked_in_at',
      'a.started_at',
      'a.finished_at',
      'p.duration_minutes as duracao_agenda_min',
    ])
    .where('a.starts_at', '>=', de)
    .where('a.starts_at', '<', ate)
    .orderBy('a.starts_at')
    .execute();
  // price_cents é bigint: chega como string do driver e vira inteiro aqui, na
  // borda, conferido — dinheiro do Fliqo nunca é float (CLAUDE.md, regra 1).
  return linhas.map((l) => {
    const price_cents = Number(l.price_cents);
    assertCents(price_cents, 'preço da consulta');
    return { ...l, price_cents };
  });
}
