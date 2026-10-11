import type { ClienteWhatsApp } from './cliente';
import type { FalhaDaMeta } from './erros-meta';
import {
  conferirCorpo,
  TEMPLATES_META,
  valoresDoCorpo,
  type ChaveDeTemplate,
  type ParametrosDe,
} from './templates';

/**
 * O envio de um template para um paciente de uma clínica, do nome ao wamid gravado.
 *
 * ESTA FUNÇÃO NÃO É O PORTEIRO DA LGPD. O porteiro é `enviarAtivo`, em
 * apps/worker/src/envio.ts: é lá que `whatsapp_consent_at` é conferido, e existe um lugar
 * só para isso de propósito — se cada caminho de envio decidisse por conta própria,
 * bastaria um esquecimento para a clínica mandar mensagem ativa sem consentimento. Esta
 * função é o transporte depois daquela decisão, e há teste de guarda em
 * apps/worker/tests que recusa qualquer outro arquivo importando-a.
 *
 * Ela mora em packages/whatsapp e NÃO fala com o banco: `PortasDoEnvio` é o que o worker
 * injeta. Pacote não importa app, e um pacote de transporte que abre transação é um pacote
 * que não dá para testar sem Postgres.
 */

export interface RegistroDeEnvio {
  readonly clinicId: string;
  readonly paraE164: string;
  /** O nome como a Meta o conhece, não a chave de código. */
  readonly template: string;
  readonly wamid: string;
}

export interface PortasDoEnvio {
  /** O phone_number_id ativo da clínica, ou `undefined` se ela não tem número conectado. */
  resolverPhoneNumberId(clinicId: string): Promise<string | undefined>;
  /**
   * Grava o envio pelo wamid. `novo: false` significa que aquele wamid já estava gravado.
   *
   * Uma honestidade sobre o que isto resolve e o que não resolve: o wamid só existe DEPOIS
   * que a Meta aceitou, então gravá-lo não impede um envio duplicado — quem impede é o
   * `for update skip locked` de `app.claim_due_actions`, que entrega cada ação a um worker
   * só. O que o wamid gravado compra é a mensagem aparecendo uma vez na conversa e o recibo
   * de status (enviada, entregue, lida, falhou) tendo onde se pendurar quando chegar no
   * webhook.
   */
  registrarEnvio(r: RegistroDeEnvio): Promise<{ novo: boolean }>;
}

export type MotivoDeRecusaDoTemplate =
  'clinica_sem_numero' | 'parametro_ausente' | 'parametro_vazio' | 'corpo_invalido';

export type ResultadoDeTemplate =
  | { ok: true; wamid: string; novo: boolean }
  | { ok: false; recusa: MotivoDeRecusaDoTemplate; detalhe: string }
  | { ok: false; recusa: 'meta'; falha: FalhaDaMeta; repetir: boolean; detalhe: string };

export interface EnviadorDeTemplate {
  <C extends ChaveDeTemplate>(
    clinicId: string,
    paraE164: string,
    template: C,
    parametros: ParametrosDe<C>,
  ): Promise<ResultadoDeTemplate>;
}

/**
 * `template` é a CHAVE de código (`confirmacaoConsulta`), não o nome na Meta
 * (`fliqo_confirmacao_consulta`). A chave é o que permite ao TypeScript saber quais
 * parâmetros aquele template exige: errar um nome de parâmetro, ou esquecer um, não
 * compila. Com o nome da Meta como entrada, `parametros` viraria um `Record<string,string>`
 * qualquer e o erro só apareceria no celular do paciente.
 */
export function criarEnviadorDeTemplate(
  cliente: ClienteWhatsApp,
  portas: PortasDoEnvio,
): EnviadorDeTemplate {
  return async function enviarTemplateDaClinica<C extends ChaveDeTemplate>(
    clinicId: string,
    paraE164: string,
    template: C,
    parametros: ParametrosDe<C>,
  ): Promise<ResultadoDeTemplate> {
    const def = TEMPLATES_META[template];

    /*
     * Confere o próprio catálogo antes de falar com a Meta. Há teste que roda isto em todas
     * as definições, então em produção não deveria falhar nunca — e é exatamente por isso
     * que a checagem fica aqui também: se falhar, falha em UM envio com motivo escrito, e
     * não em todos os envios com "parâmetros não correspondem" vindo da Meta.
     */
    const problemas = conferirCorpo(def);
    if (problemas.length > 0) {
      return {
        ok: false,
        recusa: 'corpo_invalido',
        detalhe: `${def.nome}: ${problemas.join(', ')}`,
      };
    }

    const corpo = valoresDoCorpo(def, parametros);
    if (!corpo.ok) {
      return { ok: false, recusa: corpo.motivo, detalhe: `${def.nome}: ${corpo.parametro}` };
    }

    const phoneNumberId = await portas.resolverPhoneNumberId(clinicId);
    if (phoneNumberId === undefined) {
      return {
        ok: false,
        recusa: 'clinica_sem_numero',
        detalhe: 'a clínica não tem número de WhatsApp conectado',
      };
    }

    const r = await cliente.enviarTemplate({
      phoneNumberId,
      paraE164,
      template: def.nome,
      idioma: def.idioma,
      ...(corpo.valores.length > 0 ? { variaveis: corpo.valores } : {}),
      ...(def.botoes.length > 0 ? { botoes: def.botoes.map((b) => b.payload) } : {}),
    });

    if (!r.ok) {
      return {
        ok: false,
        recusa: 'meta',
        falha: r.falha,
        repetir: r.motivo === 'temporario',
        detalhe: r.detalhe,
      };
    }

    const { novo } = await portas.registrarEnvio({
      clinicId,
      paraE164,
      template: def.nome,
      wamid: r.wamid,
    });
    return { ok: true, wamid: r.wamid, novo };
  };
}
