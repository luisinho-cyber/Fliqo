/**
 * Os dois identificadores públicos do Embedded Signup.
 *
 * Eles chegam ao navegador como prop, porque o SDK da Meta roda lá e não há
 * como não chegarem. São identificadores, não credenciais: o código que o
 * navegador recebe ao fim do fluxo só vira token no servidor da API, que é o
 * único lugar com o segredo do app. O painel nunca lê esse segredo — há guarda
 * de teste que quebra se o nome dele aparecer em qualquer arquivo de apps/web,
 * comentário incluído, porque a guarda não sabe ler intenção.
 *
 * Sem prefixo NEXT_PUBLIC_: quem lê é o componente de servidor, que decide o
 * que passa como prop. NEXT_PUBLIC_ injetaria a variável no pacote do
 * navegador inteiro, para toda página, inclusive as que não têm nada com isto.
 */
export interface ConfigDoSignup {
  appId: string;
  configId: string;
}

export function configDoSignup(env: NodeJS.ProcessEnv = process.env): ConfigDoSignup | undefined {
  const appId = env.META_APP_ID;
  const configId = env.META_CONFIG_ID;
  // Faltar não é bug de código: é uma clínica cujo ambiente ainda não foi
  // configurado. A tela diz isso em português, em vez de estourar.
  if (!appId || !configId) return undefined;
  return { appId, configId };
}
