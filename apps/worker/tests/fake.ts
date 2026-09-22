import type {
  ClienteWhatsApp,
  EnvioDeTemplate,
  EnvioDeTexto,
  ResultadoEnvio,
} from '@fliqo/whatsapp';

/**
 * Cliente falso. Guarda o que "enviou" para o teste conferir, e permite roteirizar
 * falhas — mandar mensagem de verdade em teste é inaceitável.
 */
export class WhatsappFalso implements ClienteWhatsApp {
  readonly enviados: EnvioDeTemplate[] = [];
  readonly textos: EnvioDeTexto[] = [];
  /** Respostas roteirizadas, consumidas em ordem. Vazio = sucesso. */
  readonly roteiro: ResultadoEnvio[] = [];
  #n = 0;

  falharComTemporario(vezes: number): void {
    for (let i = 0; i < vezes; i++) {
      this.roteiro.push({ ok: false, motivo: 'temporario', detalhe: 'instabilidade simulada' });
    }
  }

  falharComRecusa(): void {
    this.roteiro.push({ ok: false, motivo: 'recusado', detalhe: 'template inexistente' });
  }

  enviarTemplate(p: EnvioDeTemplate): Promise<ResultadoEnvio> {
    const roteirizado = this.roteiro.shift();
    if (roteirizado && !roteirizado.ok) return Promise.resolve(roteirizado);
    this.enviados.push(p);
    return Promise.resolve({ ok: true, wamid: `wamid.FALSO.${++this.#n}` });
  }

  enviarTexto(p: EnvioDeTexto): Promise<ResultadoEnvio> {
    this.textos.push(p);
    return Promise.resolve({ ok: true, wamid: `wamid.FALSO.${++this.#n}` });
  }
}
