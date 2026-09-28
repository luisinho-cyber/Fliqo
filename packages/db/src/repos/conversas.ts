import { sql, type Selectable } from 'kysely';
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

export interface ItemDaCaixa {
  id: string;
  modo: ModoConversa;
  motivoHandover: string | null;
  ultimaEntradaEm: Date | null;
  pacienteId: string;
  paciente: string;
  telefone: string;
  consentimentoEm: Date | null;
  ultimaMensagem: { corpo: string | null; autor: AutorMensagem; em: Date } | undefined;
}

export type EstadoDaCaixa = 'humano' | 'assistente' | 'todas';

/**
 * A caixa de entrada da clínica.
 *
 * Conversa em modo humano vem em cima porque é a que tem alguém esperando: a
 * assistente já calou naquela conversa e, se ninguém responder, ninguém
 * responde. Ordenar só por recência empurraria uma pessoa esperando desde ontem
 * para o fim da lista.
 *
 * O telefone sai daqui inteiro. Quem decide o que mostrar é a rota: mascarado
 * na lista, inteiro na ficha.
 */
export async function listarParaCaixaDeEntrada(
  trx: Trx,
  opcoes: { estado?: EstadoDaCaixa; limite?: number } = {},
): Promise<ItemDaCaixa[]> {
  const estado = opcoes.estado ?? 'todas';

  let q = trx
    .selectFrom('app.conversations as c')
    .innerJoin('app.patients as p', 'p.id', 'c.patient_id')
    .select([
      'c.id',
      'c.mode',
      'c.handover_reason',
      'c.last_inbound_at',
      'p.id as paciente_id',
      'p.name as paciente',
      'p.phone_e164',
      'p.whatsapp_consent_at',
    ]);

  if (estado === 'humano') q = q.where('c.mode', '=', 'humano');
  if (estado === 'assistente') q = q.where('c.mode', '=', 'ia');

  // A ordenação é parte da regra, não enfeite: quem está esperando gente vem
  // primeiro. Ordenar depois, em memória, perderia esses casos no limite.
  const linhas = await q
    .orderBy(sql`case when c.mode = 'humano' then 0 else 1 end`)
    .orderBy('c.last_inbound_at', (ob) => ob.desc().nullsLast())
    .limit(opcoes.limite ?? 100)
    .execute();

  const ultimas = await ultimaMensagemDe(
    trx,
    linhas.map((l) => l.id),
  );

  return linhas.map((l) => ({
    id: l.id,
    modo: l.mode,
    motivoHandover: l.handover_reason,
    ultimaEntradaEm: l.last_inbound_at,
    pacienteId: l.paciente_id,
    paciente: l.paciente,
    telefone: l.phone_e164,
    consentimentoEm: l.whatsapp_consent_at,
    ultimaMensagem: ultimas.get(l.id),
  }));
}

/** A última mensagem de cada conversa, numa consulta só. */
async function ultimaMensagemDe(
  trx: Trx,
  conversaIds: string[],
): Promise<Map<string, { corpo: string | null; autor: AutorMensagem; em: Date }>> {
  if (conversaIds.length === 0) return new Map();
  const linhas = await trx
    .selectFrom('app.messages')
    .distinctOn('conversation_id')
    .select(['conversation_id', 'body', 'author', 'created_at'])
    .where('conversation_id', 'in', conversaIds)
    .orderBy('conversation_id')
    .orderBy('created_at', 'desc')
    .execute();
  return new Map(
    linhas.map((l) => [l.conversation_id, { corpo: l.body, autor: l.author, em: l.created_at }]),
  );
}

export interface FichaDaConversa {
  conversa: Conversa;
  paciente: {
    id: string;
    nome: string;
    telefone: string;
    consentimentoEm: Date | null;
  };
  /** Quem falou primeiro: base para a origem do lead, sem guardar cópia dela. */
  primeira: { autor: AutorMensagem; direcao: DirecaoMensagem; em: Date } | undefined;
}

export async function ficha(trx: Trx, conversaId: string): Promise<FichaDaConversa | undefined> {
  const linha = await trx
    .selectFrom('app.conversations as c')
    .innerJoin('app.patients as p', 'p.id', 'c.patient_id')
    .selectAll('c')
    .select(['p.id as paciente_id', 'p.name as paciente', 'p.phone_e164', 'p.whatsapp_consent_at'])
    .where('c.id', '=', conversaId)
    .executeTakeFirst();
  if (!linha) return undefined;

  const primeira = await trx
    .selectFrom('app.messages')
    .select(['author', 'direction', 'created_at'])
    .where('conversation_id', '=', conversaId)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();

  return {
    conversa: {
      id: linha.id,
      clinic_id: linha.clinic_id,
      patient_id: linha.patient_id,
      mode: linha.mode,
      handover_reason: linha.handover_reason,
      last_inbound_at: linha.last_inbound_at,
    },
    paciente: {
      id: linha.paciente_id,
      nome: linha.paciente,
      telefone: linha.phone_e164,
      consentimentoEm: linha.whatsapp_consent_at,
    },
    primeira:
      primeira === undefined
        ? undefined
        : { autor: primeira.author, direcao: primeira.direction, em: primeira.created_at },
  };
}
