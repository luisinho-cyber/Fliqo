import type { PapelMembro, Trx } from '@fliqo/db';
import { jwtVerify } from 'jose';

/**
 * Autenticação do painel: JWT do Supabase.
 *
 * O token diz QUEM é a pessoa (`sub`). Ele nunca diz de qual clínica ela é — isso
 * vem de app.clinic_members, dentro da transação. Se o token trouxesse o
 * clinic_id, bastaria um token antigo para continuar entrando numa clínica de
 * onde a pessoa já saiu.
 */

export interface Usuario {
  userId: string;
  clinicId: string;
  papel: PapelMembro;
}

export type Autenticacao =
  { ok: true; userId: string } | { ok: false; motivo: 'sem_token' | 'token_invalido' };

/** Verifica a assinatura do token e extrai o usuário. Não consulta o banco. */
export async function autenticar(
  authorization: unknown,
  segredo: Uint8Array,
): Promise<Autenticacao> {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return { ok: false, motivo: 'sem_token' };
  }
  try {
    const { payload } = await jwtVerify(authorization.slice('Bearer '.length), segredo);
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0) return { ok: false, motivo: 'token_invalido' };
    return { ok: true, userId: sub };
  } catch {
    // Assinatura errada, expirado, malformado: tudo é a mesma resposta para quem chama.
    return { ok: false, motivo: 'token_invalido' };
  }
}

/**
 * Confirma que a pessoa é membro da clínica em que a transação está.
 *
 * A clínica vem do cabeçalho — mas isso é só um pedido, não uma credencial: se a
 * pessoa não for membro DAQUELA clínica, esta consulta não devolve linha nenhuma
 * (a RLS já limitou clinic_members ao tenant da transação) e o acesso é negado.
 * É o banco decidindo, não o código confiando no cliente.
 */
export async function membroDaClinica(trx: Trx, userId: string): Promise<PapelMembro | undefined> {
  const membro = await trx
    .selectFrom('app.clinic_members')
    .select(['role'])
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return membro?.role;
}
