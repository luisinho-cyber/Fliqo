/**
 * O contrato de ambiente do painel.
 *
 * Existe porque o painel era o único dos três serviços que subia SEM conferir nada:
 * `lerConfigSupabase` e `enderecoDaApi` só estouram quando alguém abre uma tela, então
 * um deploy com `SUPABASE_URL` faltando ficava verde no Railway, com health check
 * respondendo 200, e quebrava no primeiro login. Health check verde com login quebrado é
 * o pior estado possível: ninguém olha o serviço que está "de pé".
 *
 * Este módulo não importa NADA — nem Next, nem `@fliqo/db`. Duas razões: ele roda no
 * `instrumentation.ts`, antes de o servidor existir, e o teste de contrato na raiz o
 * importa direto. Dependência aqui viraria dependência do contrato.
 */

/** Nome da variável e como ela chega. */
export interface VariavelDoPainel {
  nome: string;
  /** Faltar derruba o processo? */
  obrigatoria: boolean;
  /** O que acontece se faltar, para a mensagem de erro servir para algo. */
  porque: string;
}

export const VARIAVEIS_DO_PAINEL: readonly VariavelDoPainel[] = [
  {
    nome: 'API_URL',
    obrigatoria: true,
    porque: 'o painel fala só com a nossa API; sem o endereço dela não há tela nenhuma',
  },
  {
    nome: 'SUPABASE_URL',
    obrigatoria: true,
    porque: 'é por onde o login autentica',
  },
  {
    nome: 'SUPABASE_ANON_KEY',
    obrigatoria: true,
    porque: 'idem; sem ela o login falha com erro de rede, que não explica nada',
  },
  {
    nome: 'NODE_ENV',
    obrigatoria: true,
    porque: 'em `production` é o que faz o cookie de sessão sair `Secure`',
  },
  {
    // Faltar não é bug: é uma clínica cujo Embedded Signup ainda não foi configurado,
    // e a tela de WhatsApp diz isso em português em vez de estourar.
    nome: 'META_APP_ID',
    obrigatoria: false,
    porque: 'sem ela a tela de conectar WhatsApp aparece explicando que falta configurar',
  },
  {
    nome: 'META_CONFIG_ID',
    obrigatoria: false,
    porque: 'idem',
  },
];

/**
 * A URL de dono do schema não entra em serviço nenhum, e o painel não é exceção.
 *
 * A recusa é escrita aqui, e não importada de `@fliqo/db`, porque o painel não importa
 * o pacote de banco — nem o tipo (CLAUDE.md, regra 10), e nem valeria arrastar `pg` para
 * o pacote do Next. O teste de contrato confere que os TRÊS serviços recusam, chamando
 * cada um: o que amarra os dois textos é comportamento, não cópia.
 */
export const VARIAVEL_DE_DONO = 'DATABASE_ADMIN_URL';

export class AmbienteInvalido extends Error {}

export function validarAmbienteDoPainel(env: NodeJS.ProcessEnv = process.env): void {
  if (env[VARIAVEL_DE_DONO] !== undefined) {
    throw new AmbienteInvalido(
      `configuração inválida do painel (serviço "web"): ${VARIAVEL_DE_DONO} não vai para serviço nenhum — ` +
        'ela é a conexão de dono do schema, que não passa pela RLS (CLAUDE.md, regra 2). ' +
        'Remova a variável deste serviço no Railway.',
    );
  }

  const faltando = VARIAVEIS_DO_PAINEL.filter((v) => v.obrigatoria && (env[v.nome] ?? '') === '');
  if (faltando.length > 0) {
    const problemas = faltando.map((v) => `${v.nome} (${v.porque})`).join('; ');
    throw new AmbienteInvalido(`configuração inválida do painel (serviço "web"): ${problemas}`);
  }
}
