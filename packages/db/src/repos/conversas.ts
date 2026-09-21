import type { Selectable } from 'kysely';
import { ehViolacaoDeUnicidade } from '../erros';
import type {
  AutorMensagem,
  DirecaoMensagem,
  ModoConversa,
  TabelaConversas,
  TabelaMensagens,
} from '../schema';
import { sobSavepoint, type Trx } from '../withClinic';

export type Conversa = Selectable<TabelaConversas>;
export type Mensagem = Selectable<TabelaMensagens>;

export async function porId(trx: Trx, id: string): Promise<Conversa | undefined> {
  return trx.selectFrom('app.conversations').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function acharOuCriarPorPaciente(
  trx: Trx,
  clinicId: string,
  pacienteId: string,
): Promise<Conversa> {
  const existente = await trx
    .selectFrom('app.conversations')
    .selectAll()
    .where('patient_id', '=', pacienteId)
    .executeTakeFirst();
  if (existente) return existente;

  return trx
    .insertInto('app.conversations')
    .values({ clinic_id: clinicId, patient_id: pacienteId })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** 'humano' silencia a IA; 'ia' devolve a conversa para ela. */
export async function definirModo(
  trx: Trx,
  conversaId: string,
  modo: ModoConversa,
  motivo?: string,
): Promise<Conversa | undefined> {
  return trx
    .updateTable('app.conversations')
    .set({ mode: modo, handover_reason: modo === 'humano' ? (motivo ?? null) : null })
    .where('id', '=', conversaId)
    .returningAll()
    .executeTakeFirst();
}

export async function marcarEntrada(trx: Trx, conversaId: string, em: Date): Promise<void> {
  await trx
    .updateTable('app.conversations')
    .set({ last_inbound_at: em })
    .where('id', '=', conversaId)
    .execute();
}

export interface MensagemNova {
  conversaId: string;
  clinicId: string;
  direcao: DirecaoMensagem;
  autor: AutorMensagem;
  wamid?: string;
  corpo?: string;
  tipoMidia?: 'audio' | 'imagem' | 'documento';
}

/**
 * Grava a mensagem uma vez só.
 *
 * A Meta reenvia o mesmo evento quando não recebe 200 a tempo, e `wamid` é único
 * no banco. `novo: false` significa "já tinha chegado" — quem chamou não deve
 * enfileirar processamento de novo, senão o paciente recebe duas respostas.
 */
export async function registrar(
  trx: Trx,
  m: MensagemNova,
): Promise<{ mensagem: Mensagem; novo: boolean }> {
  const inserida = await sobSavepoint(
    trx,
    'gravar_mensagem',
    () =>
      trx
        .insertInto('app.messages')
        .values({
          clinic_id: m.clinicId,
          conversation_id: m.conversaId,
          direction: m.direcao,
          author: m.autor,
          wamid: m.wamid ?? null,
          body: m.corpo ?? null,
          media_kind: m.tipoMidia ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    ehViolacaoDeUnicidade,
  );

  if (inserida) return { mensagem: inserida, novo: true };

  const jaExistia = await trx
    .selectFrom('app.messages')
    .selectAll()
    .where('wamid', '=', m.wamid ?? null)
    .executeTakeFirstOrThrow();
  return { mensagem: jaExistia, novo: false };
}

/** Histórico em ordem cronológica, limitado às N últimas (o prompt da IA usa 20). */
export async function ultimasMensagens(
  trx: Trx,
  conversaId: string,
  quantidade = 20,
): Promise<Mensagem[]> {
  const recentes = await trx
    .selectFrom('app.messages')
    .selectAll()
    .where('conversation_id', '=', conversaId)
    .orderBy('created_at', 'desc')
    .limit(quantidade)
    .execute();
  return recentes.reverse();
}
