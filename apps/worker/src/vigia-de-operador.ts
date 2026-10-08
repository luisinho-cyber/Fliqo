import {
  causasAtivas,
  decidirEnvio,
  dentroDoHorarioDeOperacao,
  frasesDoAviso,
  CAUSAS_DE_OPERADOR,
  type CausaDeOperador,
  type LimitesDoOperador,
  type SaudeDaClinica,
} from '@fliqo/core';
import { operador, withClinic, type Db } from '@fliqo/db';
import { enviarEmail, type ConfigDeEmail } from './email';

/**
 * O vigia do operador: de 15 em 15 minutos, em horário comercial.
 *
 * Ele existe porque a observabilidade de hoje para e começa na tela da clínica. Uma clínica
 * com o WhatsApp fora abre UM alerta urgente — e se ninguém abrir a tela, o silêncio continua
 * indefinidamente com o `/health` do worker verde, porque o batimento é por rodada concluída e
 * não por mensagem entregue. Este job é o que transforma isso em algo que chega sem alguém
 * precisar olhar.
 *
 * A decisão de ENVIAR é de `packages/core` e é pura. Aqui mora só o que é inevitável: ler o
 * agregado, gravar o reenvio por clínica, mandar o e-mail.
 */

export interface DependenciasDoVigia {
  db: Db;
  email: ConfigDeEmail;
  /** Fuso do OPERADOR, não da clínica: é a caixa de entrada dele que toca. */
  fusoDoOperador: string;
  agora?: () => Date;
  limites?: LimitesDoOperador;
  /**
   * O portão de horário, injetável.
   *
   * Existe porque as janelas do vigia são relativas ao `now()` do BANCO (ação vencida há 30
   * min, alerta aberto há 40) e o portão é relativo ao relógio do OPERADOR. Um teste que
   * fixasse um `agora` para controlar o portão passaria a comparar instante fixo com dado
   * relativo, e mediria a diferença entre as duas datas em vez da regra.
   *
   * O padrão é a regra de verdade, e ela tem teste próprio em packages/core — seis casos,
   * incluindo as bordas e o fim de semana.
   */
  horarioPermitido?: (agora: Date) => boolean;
}

export interface ResumoDoVigia {
  /** `false` quando a rodada nem olhou: fora do horário de operação. */
  rodou: boolean;
  clinicasVistas: number;
  avisadas: number;
  /** Causas que estavam gravadas e deixaram de existir: teto rearmado. */
  esquecidas: number;
  /** Quem tinha causa mas não recebeu e-mail, e por quê. Vira log. */
  calados: { clinicId: string; causa: CausaDeOperador; motivo: string }[];
  falhas: { clinicId: string; detalhe: string }[];
}

/** O assunto do e-mail. Curto, e já diz a clínica: o operador lê a lista de longe. */
function assunto(saude: SaudeDaClinica, causas: readonly CausaDeOperador[]): string {
  const primeira = causas[0] ?? 'whatsapp_fora';
  const rotulo =
    primeira === 'whatsapp_fora'
      ? 'WhatsApp fora'
      : primeira === 'silencio'
        ? 'nenhuma mensagem saindo'
        : 'qualidade do número caiu';
  return `Fliqo — ${saude.clinicaNome}: ${rotulo}`;
}

export async function vigiarOperador(dep: DependenciasDoVigia): Promise<ResumoDoVigia> {
  const agora = dep.agora?.() ?? new Date();
  const resumo: ResumoDoVigia = {
    rodou: false,
    clinicasVistas: 0,
    avisadas: 0,
    esquecidas: 0,
    calados: [],
    falhas: [],
  };

  /*
   * Fora do horário, nem lê. Não é só economia: ler e não enviar deixaria a tabela de reenvio
   * parada enquanto a causa envelhece, e o primeiro e-mail da manhã sairia com o teto já
   * contando de ontem.
   */
  const permitido =
    dep.horarioPermitido ?? ((q: Date) => dentroDoHorarioDeOperacao(q, dep.fusoDoOperador));
  if (!permitido(agora)) return resumo;
  resumo.rodou = true;

  const saudes = await operador.saudeDasClinicas(dep.db);
  resumo.clinicasVistas = saudes.length;

  for (const saude of saudes) {
    const causas = causasAtivas(saude, agora, dep.limites);

    /*
     * As causas que NÃO estão ativas são esquecidas antes de qualquer envio. É o que rearma o
     * teto: a clínica que caiu, foi avisada seis vezes, reconectou e cair de novo amanhã é
     * avisada de novo — em vez de ficar muda para sempre porque gastou o teto uma vez.
     */
    const inativas = CAUSAS_DE_OPERADOR.filter((c) => !causas.includes(c));

    const gravados = await withClinic(
      saude.clinicId,
      async (trx) => {
        resumo.esquecidas += await operador.esquecerCausas(trx, saude.clinicId, inativas);
        return operador.avisosDaClinica(trx);
      },
      dep.db,
    );

    const aMandar: CausaDeOperador[] = [];
    for (const causa of causas) {
      const decisao = decidirEnvio(gravados.get(causa), agora, dep.limites);
      if (decisao.enviar) aMandar.push(causa);
      else resumo.calados.push({ clinicId: saude.clinicId, causa, motivo: decisao.motivo });
    }
    if (aMandar.length === 0) continue;

    const frases = frasesDoAviso(saude, aMandar, agora);
    const r = await enviarEmail(dep.email, {
      assunto: assunto(saude, aMandar),
      corpo: `${frases.join('\n\n')}\n\nClínica: ${saude.clinicaNome}\nFliqo — vigia de operador.`,
    });

    if (!r.ok) {
      // Não grava: e-mail que não saiu não pode consumir o teto, senão uma chave errada
      // silenciaria o aviso para sempre depois de seis tentativas falhas.
      resumo.falhas.push({ clinicId: saude.clinicId, detalhe: r.detalhe });
      continue;
    }

    await withClinic(
      saude.clinicId,
      async (trx) => {
        for (const causa of aMandar) {
          await operador.registrarEnvio(trx, saude.clinicId, causa, agora);
        }
      },
      dep.db,
    );
    resumo.avisadas++;
  }

  return resumo;
}
