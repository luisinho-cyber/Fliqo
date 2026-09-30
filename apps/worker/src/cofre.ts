import { conexao, numeros, withClinic, type Db } from '@fliqo/db';
import { decifrar, type CofreDeTokens } from '@fliqo/whatsapp';

/**
 * O cofre de tokens de envio, um por clínica.
 *
 * Antes disto o worker mandava tudo com um token único de ambiente, e o token
 * cifrado que a clínica conectava não era usado por ninguém — ou seja, conectar o
 * WhatsApp da clínica guardava a credencial dela e a mensagem continuava saindo
 * pelo número da Fliqo.
 *
 * O caminho de leitura é o mesmo do webhook, e de propósito: `clinicaDoNumero`
 * (`security definer`, a única coisa que roda antes de haver clínica) descobre de
 * quem é o número, e só então `withClinic` abre a transação em que a RLS deixa
 * ler o token daquela clínica. Nenhuma função nova cruzando clínicas, nenhum
 * caminho novo para credencial.
 */

/**
 * Teto de entradas.
 *
 * Cada entrada é um token de acesso EM CLARO na memória do processo. Sem teto, o
 * cofre cresce com o número de clínicas, e o teto é exatamente quantas
 * credenciais um dump de heap — um core dump, um inspetor aberto por engano —
 * exporia de uma vez. Passando do teto sai a entrada mais antiga: o pior caso é
 * uma leitura e uma decifragem a mais, nunca um envio errado.
 */
export const TETO_DE_ENTRADAS = 64;

/**
 * Validade de uma entrada.
 *
 * Cinco minutos porque uma rodada de cinquenta ações com envio lento cabe dentro
 * de uma validade — então uma rodada faz no máximo uma leitura por clínica — e
 * porque é o tempo máximo que um token fica em memória depois de deixar de ser
 * usado.
 *
 * Não é isto que trata token trocado: quem trata é a renovação por credencial
 * recusada, no cliente da Meta. A validade é só o teto de permanência em memória.
 */
export const VALIDADE_MS = 5 * 60_000;

interface Entrada {
  token: string;
  expiraEm: number;
}

export interface ConfigCofre {
  db: Db;
  chave: Buffer;
  agora?: () => number;
  tetoDeEntradas?: number;
  validadeMs?: number;
}

export function criarCofre(cfg: ConfigCofre): CofreDeTokens {
  const agora = cfg.agora ?? Date.now;
  const teto = cfg.tetoDeEntradas ?? TETO_DE_ENTRADAS;
  const validade = cfg.validadeMs ?? VALIDADE_MS;
  // Map preserva ordem de inserção, que é o que permite descartar a mais antiga
  // sem guardar contador de acesso nenhum.
  const entradas = new Map<string, Entrada>();

  function guardar(phoneNumberId: string, token: string): void {
    entradas.delete(phoneNumberId);
    entradas.set(phoneNumberId, { token, expiraEm: agora() + validade });
    while (entradas.size > teto) {
      const maisAntiga = entradas.keys().next();
      if (maisAntiga.done === true) break;
      entradas.delete(maisAntiga.value);
    }
  }

  return {
    async doNumero(phoneNumberId: string): Promise<string | undefined> {
      const guardada = entradas.get(phoneNumberId);
      if (guardada !== undefined && guardada.expiraEm > agora()) return guardada.token;
      entradas.delete(phoneNumberId);

      const clinicId = await numeros.clinicaDoNumero(cfg.db, phoneNumberId);
      // Número desconhecido ou desativado: não há clínica, e portanto não há
      // token. Quem chamou transforma isso em falha definitiva.
      if (clinicId === undefined) return undefined;

      const cifrado = await withClinic(
        clinicId,
        (trx) => conexao.tokenCifradoDoNumero(trx, phoneNumberId),
        cfg.db,
      );
      if (cifrado === undefined) return undefined;

      const aberto = decifrar(cifrado, cfg.chave);
      // Decifragem falhando é chave trocada sem recifrar (veja a rotação em
      // docs/OPERACAO.md). Não é erro de programa: é a clínica precisando
      // reconectar, e o envio falha definitivo em vez de estourar.
      if (!aberto.ok) return undefined;

      guardar(phoneNumberId, aberto.token);
      return aberto.token;
    },

    esquecer(phoneNumberId: string): void {
      entradas.delete(phoneNumberId);
    },
  };
}
