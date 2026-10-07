import type { MotivoDeFalha } from './cliente';

/**
 * Os erros da Meta que têm conduta diferente, tipados.
 *
 * Antes disto, o cliente classificava só por status HTTP: 429 e 5xx eram temporários, todo
 * o resto era "recusado" com a mensagem da Meta numa string. Funciona para decidir se vale
 * repetir, e não serve para mais nada — e justamente os casos que importam são todos 400:
 * número que não recebe WhatsApp, janela de 24 h fechada, template com contagem de
 * parâmetro errada e template que não existe chegam com o MESMO status. Tratá-los por
 * string é escrever `detalhe.includes('template')` em algum lugar, que quebra quando a Meta
 * reescreve a frase — e ela reescreve.
 */
export type FalhaDaMeta =
  /**
   * 131026. O número não recebe mensagem: não tem WhatsApp, é fixo, ou foi digitado
   * errado. Definitivo, e é problema de CADASTRO — repetir nunca resolve, e a recepção
   * precisa saber para ligar e corrigir o telefone.
   */
  | 'destinatario_indisponivel'
  /**
   * 131047. Passaram mais de 24 h desde a última mensagem do paciente, então texto livre
   * não sai mais — só template.
   *
   * Num envio de TEMPLATE este código não deveria aparecer: template é exatamente o que
   * reabre a janela. Se aparecer num envio de template, o que está errado é o template
   * (pausado, reprovado ou reclassificado para marketing sem opt-in), não a janela.
   * Quem recebe isto em `enviarTexto` tem conduta clara: mandar o template que
   * corresponde ao assunto em vez da resposta livre.
   */
  | 'fora_da_janela'
  /**
   * 132000. A quantidade de parâmetros do envio não é a do template aprovado.
   *
   * A Meta chama isto de "number of parameters mismatch", e é o erro que o corpo em
   * `templates.ts` existe para tornar impossível: lá a contagem é CONTADA do texto, não
   * declarada. Se este código aparecer, o corpo aprovado na Meta não é o corpo do
   * repositório — alguém editou o template no painel da Meta.
   */
  | 'parametros_do_template'
  /**
   * 132001. O template não existe com esse nome nesse idioma, ou não está aprovado.
   * Definitivo, e é problema de REGISTRO: roda `registrar-templates.ts` e confere o status
   * na Meta.
   */
  | 'template_inexistente'
  /** 429, ou 131048/131056: ritmo. Vale repetir. */
  | 'limite_de_envio'
  /** 5xx: a Meta caiu. Vale repetir. */
  | 'instabilidade_da_meta'
  /** Qualquer coisa que não reconhecemos. A conduta vem do status HTTP, como antes. */
  | 'desconhecida';

export interface ClassificacaoDaFalha {
  readonly falha: FalhaDaMeta;
  readonly motivo: MotivoDeFalha;
  /**
   * O que fazer, em uma frase, para quem lê log ou alerta. Nunca contém telefone, nome de
   * paciente nem conteúdo de mensagem: isto vai para o pino.
   */
  readonly conduta: string;
}

const PORCODIGO = new Map<number, ClassificacaoDaFalha>([
  [
    131026,
    {
      falha: 'destinatario_indisponivel',
      motivo: 'recusado',
      conduta: 'o número não recebe WhatsApp; confira o telefone no cadastro do paciente',
    },
  ],
  [
    131047,
    {
      falha: 'fora_da_janela',
      motivo: 'recusado',
      conduta: 'janela de 24 h fechada; só template reabre a conversa',
    },
  ],
  [
    132000,
    {
      falha: 'parametros_do_template',
      motivo: 'recusado',
      conduta:
        'o corpo aprovado na Meta tem outra quantidade de variáveis que a do código; ' +
        'compare com templates.ts e reaprove',
    },
  ],
  [
    132001,
    {
      falha: 'template_inexistente',
      motivo: 'recusado',
      conduta: 'template não existe ou não está aprovado neste idioma; rode registrar-templates',
    },
  ],
  [
    131048,
    {
      falha: 'limite_de_envio',
      motivo: 'temporario',
      conduta: 'limite de envio do número atingido; vai sair na próxima tentativa',
    },
  ],
  [
    131056,
    {
      falha: 'limite_de_envio',
      motivo: 'temporario',
      conduta: 'muitas mensagens para o mesmo paciente em sequência; vai sair na próxima tentativa',
    },
  ],
]);

/**
 * Classifica a resposta de erro da Meta.
 *
 * O CÓDIGO manda, e o status HTTP é só o que sobra: a Meta devolve 400 para erro
 * definitivo e para limite, e o código é o único jeito de separar os dois. Código
 * desconhecido cai na regra antiga — repetir 429 e 5xx, desistir do resto — porque errar
 * para o lado de repetir num definitivo gasta limite do número da clínica.
 */
export function classificarFalha(status: number, codigo?: number): ClassificacaoDaFalha {
  if (codigo !== undefined) {
    const conhecida = PORCODIGO.get(codigo);
    if (conhecida) return conhecida;
  }

  if (status === 429) {
    return {
      falha: 'limite_de_envio',
      motivo: 'temporario',
      conduta: 'limite de envio atingido; vai sair na próxima tentativa',
    };
  }
  if (status >= 500) {
    return {
      falha: 'instabilidade_da_meta',
      motivo: 'temporario',
      conduta: 'a Meta respondeu erro de servidor; vai sair na próxima tentativa',
    };
  }
  return {
    falha: 'desconhecida',
    motivo: 'recusado',
    conduta: 'a Meta recusou o envio e o código não é um dos tratados; leia o detalhe',
  };
}

/** Os códigos com conduta própria, para o teste e para a documentação não divergirem. */
export const CODIGOS_TRATADOS: readonly number[] = [...PORCODIGO.keys()];
