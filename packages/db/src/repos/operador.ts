import { HORAS_DE_SILENCIO, type CausaDeOperador, type SaudeDaClinica } from '@fliqo/core';
import { sql } from 'kysely';
import type { Db } from '../conexao';
import type { Trx } from '../withClinic';

/**
 * A saúde das clínicas para o operador, e o estado do reenvio.
 *
 * Os dois lados têm acessos diferentes de propósito:
 *
 *   * `saudeDasClinicas` roda FORA de `withClinic`, pela função `security definer` da 0015 —
 *     é a única leitura cruzada, e ela devolve só agregado;
 *   * `avisoJaMandado` e `registrarEnvio` rodam DENTRO de `withClinic`, uma clínica por vez,
 *     presos pela RLS como todo o resto.
 *
 * Essa divisão é o que evita uma sétima função definer e uma tabela fora da RLS.
 */

interface LinhaDeSaude {
  clinic_id: string;
  clinic_name: string;
  whatsapp_fora_desde: Date | null;
  enviadas_ultima_hora: string;
  enviadas_na_janela: string;
  vencidas_na_janela: string;
  vencidas_pendentes: string;
  qualidade: string | null;
}

/**
 * Lê a saúde de todas as clínicas ativas e não-demo.
 *
 * Recebe a conexão e não a transação porque não há clínica na transação: é cruzada por
 * natureza. Clínica de demonstração fica fora — o `is_demo` da 0001 existe para a agenda
 * fabricada da venda não virar alerta de operador às três da manhã.
 */
export async function saudeDasClinicas(
  db: Db,
  janelaDeSilencioHoras: number = HORAS_DE_SILENCIO,
): Promise<SaudeDaClinica[]> {
  const r = await sql<LinhaDeSaude>`
    select * from app.operator_health(${janelaDeSilencioHoras})
  `.execute(db);

  // bigint chega como string do driver. Contagem de mensagem de uma hora cabe folgado no
  // inteiro seguro, então o Number é seguro aqui.
  return r.rows.map((l) => ({
    clinicId: l.clinic_id,
    clinicaNome: l.clinic_name,
    whatsappForaDesde: l.whatsapp_fora_desde,
    enviadasNaUltimaHora: Number(l.enviadas_ultima_hora),
    enviadasNaJanela: Number(l.enviadas_na_janela),
    vencidasNaJanela: Number(l.vencidas_na_janela),
    vencidasPendentes: Number(l.vencidas_pendentes),
    qualidade: l.qualidade,
  }));
}

export interface AvisoGravado {
  cause: CausaDeOperador;
  envios: number;
  ultimoEnvioEm: Date;
  vistoPrimeiroEm: Date;
}

/** Os avisos já mandados para esta clínica, por causa. Dentro de `withClinic`. */
export async function avisosDaClinica(trx: Trx): Promise<Map<CausaDeOperador, AvisoGravado>> {
  const linhas = await trx.selectFrom('app.operator_notices').selectAll().execute();
  return new Map(
    linhas.map((l) => [
      l.cause,
      {
        cause: l.cause,
        envios: l.sends,
        ultimoEnvioEm: l.last_sent_at,
        vistoPrimeiroEm: l.first_seen_at,
      },
    ]),
  );
}

/**
 * Registra que o e-mail saiu. Primeira vez insere; reenvio soma.
 *
 * `first_seen_at` NÃO é tocado no reenvio: ele é a idade do problema, e sobrescrevê-lo faria
 * um WhatsApp fora há seis horas parecer recém-caído a cada e-mail.
 */
export async function registrarEnvio(
  trx: Trx,
  clinicId: string,
  causa: CausaDeOperador,
  em: Date,
): Promise<void> {
  await trx
    .insertInto('app.operator_notices')
    .values({ clinic_id: clinicId, cause: causa, first_seen_at: em, last_sent_at: em, sends: 1 })
    .onConflict((oc) =>
      oc.columns(['clinic_id', 'cause']).doUpdateSet({
        last_sent_at: em,
        sends: sql<number>`app.operator_notices.sends + 1`,
      }),
    )
    .execute();
}

/**
 * A causa passou: apaga a linha, e o próximo episódio começa do zero.
 *
 * Apagar em vez de carimbar `resolved_at` porque o histórico de quem já foi avisado não é
 * perguntado por ninguém — o e-mail enviado é o registro. Linha apagada é teto rearmado, que
 * é o comportamento desejado: a mesma clínica que cair de novo amanhã é avisada de novo.
 */
export async function esquecerCausas(
  trx: Trx,
  clinicId: string,
  causas: readonly CausaDeOperador[],
): Promise<number> {
  if (causas.length === 0) return 0;
  const r = await trx
    .deleteFrom('app.operator_notices')
    .where('clinic_id', '=', clinicId)
    .where('cause', 'in', [...causas])
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}

/**
 * A fila de envio represada agora, somada em todas as clínicas.
 *
 * É o número que o /estado do worker precisa, e ele vem da MESMA função de operador — não de
 * uma sétima função definer. Ler `scheduled_actions` direto fora de `withClinic` devolveria
 * zero pela RLS, que é o jeito mais silencioso de um veredito mentir.
 */
export async function vencidasRepresadas(db: Db): Promise<number> {
  const saudes = await saudeDasClinicas(db);
  return saudes.reduce((soma, s) => soma + s.vencidasPendentes, 0);
}
