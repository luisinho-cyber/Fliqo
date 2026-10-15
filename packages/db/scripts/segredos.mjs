/**
 * Tira segredo de texto que vai para a saída.
 *
 * Os scripts de banco rodam num workflow do GitHub, onde a saída fica guardada e
 * visível para quem tem acesso ao repositório. O GitHub já mascara os secrets que
 * ele mesmo injetou, mas isso vale para o valor exato: uma senha que apareça
 * partida, codificada ou dentro de uma URL passa. Aqui a limpeza é nossa, antes
 * de imprimir.
 */

const URL_COM_SENHA = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi;

export function semSegredos(texto, segredos = []) {
  let limpo = String(texto);
  for (const s of segredos) {
    if (typeof s !== 'string' || s.length < 4) continue;
    limpo = limpo.split(s).join('[removido]');
  }
  // Rede de segurança para uma URL que não estava na lista: a parte da senha sai
  // de qualquer jeito, e o resto fica legível para dar para entender o erro.
  return limpo.replace(URL_COM_SENHA, '$1:[removido]@');
}

/** Imprime o erro sem os segredos e encerra com falha. */
export function falhar(erro, segredos = []) {
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  console.error(`falhou: ${semSegredos(mensagem, segredos)}`);
  process.exit(1);
}
