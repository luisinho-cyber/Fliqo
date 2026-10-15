'use client';

import type { Conversa } from '../nucleo/estado';
import { Ilustracao } from './Ilustracao';

/**
 * O lado do paciente: o WhatsApp dele, ao lado da tela da clínica, mostrando o
 * que ele recebe no momento em que acontece.
 *
 * Os botões são os do template aprovado na Meta, e devolvem PAYLOAD fixo — não
 * texto. É por isso que a confirmação não passa pela assistente: não há o que
 * interpretar numa resposta que já chega como `CONFIRMAR_CONSULTA`.
 */
export function CanalDoPaciente({
  conversa,
  aoResponder,
}: {
  conversa: Conversa;
  aoResponder: (payload: string) => void;
}) {
  return (
    <div className="celular" data-testid="celular">
      <div className="celular-topo">
        <b>{conversa.paciente}</b>
        <Ilustracao>conversa desenhada, sem WhatsApp do outro lado</Ilustracao>
      </div>

      <div className="mensagens" data-testid="mensagens">
        {conversa.mensagens.map((m, i) => (
          <div className={`mensagem ${m.de}`} key={`${String(i)}-${m.texto.slice(0, 16)}`}>
            <p>{m.texto}</p>
            <span className="quando mono">{m.quando}</span>
          </div>
        ))}
      </div>

      {conversa.botoes.length > 0 && (
        <div className="botoes-template" data-testid="botoes-do-paciente">
          {conversa.botoes.map((b) => (
            <button
              key={b.payload}
              className="botao-template"
              onClick={() => {
                aoResponder(b.payload);
              }}
            >
              {b.rotulo}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
