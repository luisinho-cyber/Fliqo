import { readFileSync } from 'node:fs';
import { sql, type Selectable } from 'kysely';
import type { TabelaConsumoIa, TabelaPerfisIa } from '../schema';
import type { Trx } from '../withClinic';

export type PerfilIa = Selectable<TabelaPerfisIa>;

/**
 * O perfil que está valendo. É versionado: `one_active_profile` garante no banco
 * que só existe um ativo por clínica, então voltar atrás é trocar a flag.
 */
export async function perfilAtivo(trx: Trx): Promise<PerfilIa | undefined> {
  return trx
    .selectFrom('app.ai_profiles')
    .selectAll()
    .where('is_active', '=', true)
    .executeTakeFirst();
}

export interface ConsumoNovo {
  conversaId?: string;
  modelo: string;
  entrada: number;
  saida: number;
  cacheLido: number;
  cacheCriado: number;
}

/** Custo por clínica é o gargalo do negócio: cada chamada ao modelo é registrada. */
export async function registrarConsumo(
  trx: Trx,
  clinicId: string,
  c: ConsumoNovo,
): Promise<Selectable<TabelaConsumoIa>> {
  return trx
    .insertInto('app.ai_usage')
    .values({
      clinic_id: clinicId,
      conversation_id: c.conversaId ?? null,
      model: c.modelo,
      input_tokens: c.entrada,
      output_tokens: c.saida,
      cache_read_tokens: c.cacheLido,
      cache_creation_tokens: c.cacheCriado,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Compara o perfil guardado com o que chegou, deixando a comparação para o banco.
 *
 * Comparar `JSON.stringify` dos dois lados daria diferente sempre: o jsonb guarda as
 * chaves na ordem dele (por tamanho, depois alfabética) e não na ordem do schema, então
 * o texto nunca bate mesmo com o conteúdo idêntico — e cada rodada da semeadura abriria
 * uma versão nova. O `=` do jsonb compara conteúdo, sem ordem de chave.
 */
async function ehOMesmoPerfil(trx: Trx, id: string, perfil: unknown): Promise<boolean> {
  const r = await sql<{ igual: boolean }>`
    select profile = ${JSON.stringify(perfil)}::jsonb as igual
      from app.ai_profiles
     where id = ${id}
  `.execute(trx);
  return r.rows[0]?.igual === true;
}

export type AcaoNoPerfil = 'criado' | 'mantido' | 'nova_versao';

export interface PerfilGravado {
  acao: AcaoNoPerfil;
  versao: number;
}

/**
 * Deixa `perfil` valendo na clínica, sem criar uma versão igual à que já está ativa.
 *
 * Idempotente porque semear é um fluxo que se repete: quem prepara um ambiente de
 * demonstração roda o script de novo depois de um erro de rede, de um banco recriado
 * ou de um deploy, e uma versão nova a cada rodada encheria o histórico de versões
 * idênticas — o histórico existe para mostrar o que a clínica mudou, não o que o
 * script repetiu.
 *
 * Perfil diferente do ativo entra como versão seguinte, e não sobrescrevendo a atual:
 * é o que permite voltar atrás numa troca de persona (ai.perfilAtivo + a flag).
 * A desativação vem antes do insert porque `one_active_profile` é índice único
 * imediato: dois ativos não chegam a existir nem no meio da transação.
 */
export async function garantirPerfilAtivo(
  trx: Trx,
  clinicId: string,
  perfil: unknown,
): Promise<PerfilGravado> {
  const ativo = await perfilAtivo(trx);
  if (ativo !== undefined && (await ehOMesmoPerfil(trx, ativo.id, perfil))) {
    return { acao: 'mantido', versao: ativo.version };
  }

  const maior = await trx
    .selectFrom('app.ai_profiles')
    .select((eb) => eb.fn.max<number | null>('version').as('versao'))
    .executeTakeFirst();
  const versao = (maior?.versao ?? 0) + 1;

  if (ativo !== undefined) {
    await trx
      .updateTable('app.ai_profiles')
      .set({ is_active: false })
      .where('id', '=', ativo.id)
      .execute();
  }

  await trx
    .insertInto('app.ai_profiles')
    .values({ clinic_id: clinicId, version: versao, is_active: true, profile: perfil })
    .execute();

  return { acao: ativo === undefined ? 'criado' : 'nova_versao', versao };
}

/**
 * O perfil de demonstração, lido de packages/db/seeds/perfil-clinica-demo.json.
 *
 * Sai daqui como `unknown` de propósito: quem valida é o PerfilClinicaSchema, em
 * packages/ai, e `db` não importa `ai` (CLAUDE.md, estrutura). Dado sintético — a
 * clínica, os textos e o FAQ são inventados, e nenhum paciente aparece no arquivo.
 */
export function lerPerfilDemo(): unknown {
  const caminho = new URL('../../seeds/perfil-clinica-demo.json', import.meta.url);
  return JSON.parse(readFileSync(caminho, 'utf8')) as unknown;
}
