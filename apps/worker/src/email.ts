/**
 * O envio de e-mail ao operador. Um POST, sem biblioteca.
 *
 * Sem SDK de propósito: é uma requisição HTTP com três campos, e acrescentar dependência para
 * isso é dependência que precisa ser atualizada, auditada e explicada depois (CLAUDE.md). O
 * endereço do serviço é configurável, então trocar de provedor é mudar uma variável de
 * ambiente e o formato do corpo — não arrancar um pacote.
 *
 * A CHAVE NUNCA APARECE AQUI: ela entra por `ConfigDeEmail`, vem de `process.env` no worker, e
 * não é escrita em log, em erro nem em métrica. O `detalhe` de falha leva a frase do provedor,
 * que não contém a chave, e há teste que planta a chave e confere que ela não sai.
 */

export interface ConfigDeEmail {
  /** A chave do serviço. Só no serviço worker do Railway, em env. */
  chave: string;
  /** Remetente verificado no provedor. */
  remetente: string;
  /** Para quem o aviso vai: o operador. */
  destinatario: string;
  /** Endpoint do provedor. Tem padrão para o caminho comum não precisar de configuração. */
  url?: string;
  buscar?: typeof fetch;
}

export type ResultadoDeEmail =
  { ok: true } | { ok: false; motivo: 'recusado' | 'temporario'; detalhe: string };

const URL_PADRAO = 'https://api.resend.com/emails';

export interface Aviso {
  assunto: string;
  /** Texto puro. Sem HTML: o aviso é para ser lido no celular, em três segundos. */
  corpo: string;
}

/**
 * Manda o aviso.
 *
 * Repete nada: quem decide reenviar é o job, pela tabela de reenvio, e um retry interno aqui
 * faria o teto de seis e-mails virar dezoito sem ninguém pedir.
 */
export async function enviarEmail(cfg: ConfigDeEmail, aviso: Aviso): Promise<ResultadoDeEmail> {
  const buscar = cfg.buscar ?? fetch;
  try {
    const r = await buscar(cfg.url ?? URL_PADRAO, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.chave}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: cfg.remetente,
        to: [cfg.destinatario],
        subject: aviso.assunto,
        text: aviso.corpo,
      }),
    });

    if (r.ok) return { ok: true };

    const corpo = (await r.text()).slice(0, 300);
    // 429 e 5xx valem outra volta do job; o resto é configuração errada e repetir não conserta.
    const motivo = r.status === 429 || r.status >= 500 ? 'temporario' : 'recusado';
    return { ok: false, motivo, detalhe: `http ${String(r.status)}: ${corpo}` };
  } catch (erro) {
    return {
      ok: false,
      motivo: 'temporario',
      detalhe: erro instanceof Error ? erro.message : 'falha de rede',
    };
  }
}
