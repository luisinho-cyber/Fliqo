import { PerfilClinicaSchema } from '@fliqo/ai';
import { criarDb, ia, withClinic, type Db } from '@fliqo/db';

/**
 * Semeia a clínica de demonstração: a clínica e o perfil da IA que está valendo nela.
 *
 * Existe porque demonstrar a Fliqo exige um banco com perfil ativo — sem ele a
 * conversa não tem persona, horário de atendimento nem política de cancelamento, e
 * o agente não responde nada. O conteúdo vem de packages/db/seeds/perfil-clinica-demo.json:
 * clínica inventada, textos inventados, nenhum paciente. Semear NÃO cria paciente,
 * consulta nem mensagem.
 *
 * Idempotente de ponta a ponta: a clínica tem id fixo e o perfil só vira versão nova
 * quando o arquivo muda (ia.garantirPerfilAtivo). Rodar duas vezes não duplica nada.
 *
 * Conecta como a aplicação (DATABASE_URL, papel `fliqo_app`) e grava dentro de
 * `withClinic` — a RLS é quem põe a linha na clínica certa, inclusive a da própria
 * clínica, cuja política é `id = app.clinic_id()`.
 *
 * Uso: npm run demo:semear
 */

/**
 * O id é fixo, e é isso que torna a semeadura idempotente: `app.clinics` não tem
 * nome único, então um id sorteado criaria uma clínica demo nova a cada rodada.
 */
export const CLINICA_DEMO = '00000000-0000-4000-8000-000000000001';

export interface ResumoDaSemeadura {
  clinicaId: string;
  clinica: 'criada' | 'existente';
  perfil: ia.PerfilGravado;
}

export async function semearDemo(db: Db, perfilBruto: unknown): Promise<ResumoDaSemeadura> {
  // Valida antes de abrir transação: perfil incompleto é erro de arquivo, não de banco,
  // e a mensagem do Zod diz qual campo falta.
  const perfil = PerfilClinicaSchema.parse(perfilBruto);

  return withClinic(
    CLINICA_DEMO,
    async (trx) => {
      const criada = await trx
        .insertInto('app.clinics')
        .values({ id: CLINICA_DEMO, name: perfil.clinica.nome, is_demo: true })
        .onConflict((oc) => oc.column('id').doNothing())
        .returning('id')
        .executeTakeFirst();

      // O perfil guardado é o que saiu do Zod, com os defaults já preenchidos: é o
      // mesmo objeto que o worker leria de volta, então a segunda rodada compara igual.
      const gravado = await ia.garantirPerfilAtivo(trx, CLINICA_DEMO, perfil);

      return {
        clinicaId: CLINICA_DEMO,
        clinica: criada === undefined ? ('existente' as const) : ('criada' as const),
        perfil: gravado,
      };
    },
    db,
  );
}

// Execução por linha de comando. Importado (pelo teste), só exporta.
if (process.argv[1]?.endsWith('semear-demo.ts') === true) {
  const url = process.env.DATABASE_URL;
  if (url === undefined) {
    process.stderr.write(
      'DATABASE_URL não definida. A semeadura conecta como fliqo_app, nunca como dono do schema.\n',
    );
    process.exit(1);
  }
  const db = criarDb(url, 2);
  try {
    const resumo = await semearDemo(db, ia.lerPerfilDemo());
    process.stdout.write(
      `clínica demo ${resumo.clinica} (${resumo.clinicaId}) — ` +
        `perfil ${resumo.perfil.acao}, versão ${String(resumo.perfil.versao)}\n`,
    );
  } finally {
    await db.destroy();
  }
}
