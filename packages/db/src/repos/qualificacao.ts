import type { Selectable } from 'kysely';
import type { FaixaDeOrcamento, TabelaQualificacao } from '../schema';
import type { Trx } from '../withClinic';

/**
 * A qualificação do lead: o que a recepção sabe e a agenda não guarda.
 *
 * Só os campos que alguém digita. Origem, convênio e urgência NÃO moram aqui —
 * são derivados do que já existe (quem escreveu primeiro, os convênios do
 * perfil, o motivo do handover) e montados na leitura. Guardar cópia deles
 * criaria uma segunda verdade que envelhece sozinha.
 *
 * A assistente não escreve aqui. Quando escrever, será por ferramenta própria,
 * com validarChamada, em revisão própria.
 */

export type Qualificacao = Selectable<TabelaQualificacao>;

/**
 * Campo ausente = não mexer. Campo com `null` = apagar. São coisas diferentes:
 * mandar só a observação não pode apagar o interesse que outra pessoa escreveu.
 */
export interface QualificacaoEditavel {
  interesse?: string | null | undefined;
  faixaDeOrcamento?: FaixaDeOrcamento | null | undefined;
  observacao?: string | null | undefined;
}

export async function ler(trx: Trx, conversaId: string): Promise<Qualificacao | undefined> {
  return trx
    .selectFrom('app.lead_qualifications')
    .selectAll()
    .where('conversation_id', '=', conversaId)
    .executeTakeFirst();
}

/**
 * Grava a qualificação. `quemEditou` é o `sub` do JWT que a API verificou,
 * nunca um id que o navegador mandou.
 *
 * Um `upsert`: a primeira edição cria a linha, as seguintes atualizam. Só os
 * campos presentes em `dados` mudam — mandar só a observação não apaga o
 * interesse que outra pessoa escreveu.
 */
export async function gravar(
  trx: Trx,
  clinicId: string,
  conversaId: string,
  dados: QualificacaoEditavel,
  quemEditou: string,
): Promise<Qualificacao> {
  const mudancas = {
    ...(dados.interesse === undefined ? {} : { interest: dados.interesse }),
    ...(dados.faixaDeOrcamento === undefined ? {} : { budget_band: dados.faixaDeOrcamento }),
    ...(dados.observacao === undefined ? {} : { note: dados.observacao }),
    updated_by: quemEditou,
    updated_at: new Date(),
  };

  return trx
    .insertInto('app.lead_qualifications')
    .values({ conversation_id: conversaId, clinic_id: clinicId, ...mudancas })
    .onConflict((oc) => oc.column('conversation_id').doUpdateSet(mudancas))
    .returningAll()
    .executeTakeFirstOrThrow();
}
