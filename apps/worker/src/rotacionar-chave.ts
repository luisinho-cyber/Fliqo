import { criarDb } from '@fliqo/db';
import { lerChave, recifrar } from '@fliqo/whatsapp';
import { sql } from 'kysely';

/**
 * Troca a chave que cifra os tokens das clínicas.
 *
 * A chave vive só em variável de ambiente. Trocar a variável sem recifrar
 * deixaria todos os tokens ilegíveis, e todas as clínicas teriam que reconectar
 * o WhatsApp. Este script decifra com a chave antiga e regrava com a nova.
 *
 * Roda com a conexão de dono (DATABASE_ADMIN_URL) porque percorre todas as
 * clínicas — é manutenção, não é a aplicação. Nenhum token é impresso.
 *
 * Uso: veja docs/OPERACAO.md, seção "Trocar a chave do token".
 */

interface Linha {
  id: string;
  phone_number_id: string;
  token_ciphertext: Buffer;
  token_iv: Buffer;
  token_tag: Buffer;
}

export interface ResumoRotacao {
  recifrados: number;
  falharam: string[];
}

export async function rotacionar(
  urlDono: string,
  chaveAntigaBase64: string | undefined,
  chaveNovaBase64: string | undefined,
): Promise<ResumoRotacao> {
  const antiga = lerChave(chaveAntigaBase64);
  const nova = lerChave(chaveNovaBase64);
  const db = criarDb(urlDono, 2);
  const resumo: ResumoRotacao = { recifrados: 0, falharam: [] };

  try {
    const linhas = await sql<Linha>`
      select id, phone_number_id, token_ciphertext, token_iv, token_tag
        from app.whatsapp_numbers
       where token_ciphertext is not null
    `.execute(db);

    for (const linha of linhas.rows) {
      const r = recifrar(
        { ciphertext: linha.token_ciphertext, iv: linha.token_iv, tag: linha.token_tag },
        antiga,
        nova,
      );

      if (!r.ok) {
        // Não apaga nada: quem decide o que fazer com um token ilegível é quem opera.
        resumo.falharam.push(linha.phone_number_id);
        continue;
      }

      await sql`
        update app.whatsapp_numbers
           set token_ciphertext = ${r.novo.ciphertext},
               token_iv = ${r.novo.iv},
               token_tag = ${r.novo.tag},
               token_updated_at = now()
         where id = ${linha.id}
      `.execute(db);
      resumo.recifrados++;
    }
  } finally {
    await db.destroy();
  }

  return resumo;
}

// Execução por linha de comando. Importado (pelo teste), só exporta.
if (process.argv[1]?.endsWith('rotacionar-chave.ts') === true) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (url === undefined) {
    process.stderr.write('DATABASE_ADMIN_URL não definida — a rotação usa a conexão de dono.\n');
    process.exit(1);
  }
  const resumo = await rotacionar(
    url,
    process.env.WHATSAPP_TOKEN_KEY_ANTIGA,
    process.env.WHATSAPP_TOKEN_KEY,
  );
  // Só números, nunca token.
  process.stdout.write(`recifrados: ${String(resumo.recifrados)}\n`);
  if (resumo.falharam.length > 0) {
    process.stdout.write(`NÃO recifrados (reconectar): ${resumo.falharam.join(', ')}\n`);
    process.exit(2);
  }
}
