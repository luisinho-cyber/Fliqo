import type { ApiDeCena, Conversa } from '../nucleo/estado';

/**
 * O lado do paciente: o WhatsApp dele, ao lado da tela da clínica.
 * Quem apresenta toca nos botões aqui e a agenda muda atrás — é a demonstração
 * inteira em um gesto.
 */
export function CanalDoPaciente({ conversa, api }: { conversa: Conversa; api: ApiDeCena }) {
  return (
    <div className="celular" data-testid="celular">
      <div className="tela">
        <div className="tela-topo">
          <b>{conversa.paciente}</b>
          <span>
            {conversa.contexto} ·{' '}
            {conversa.modo === 'humano' ? 'com a recepção' : 'com a Assistente Fliqo'}
          </span>
        </div>

        <div className="msgs" data-testid="mensagens">
          {conversa.mensagens.length === 0 && (
            <p className="msg sistema">A conversa aparece aqui quando a cena começa.</p>
          )}
          {conversa.mensagens.map((m, i) => (
            <div className={`msg ${m.de}`} key={`${String(i)}-${m.texto.slice(0, 12)}`}>
              {m.texto}
              {m.hora !== undefined && <span className="h mono">{m.hora}</span>}
            </div>
          ))}
        </div>

        {conversa.botoes.length > 0 && (
          <div className="botoes" data-testid="botoes-do-paciente">
            {conversa.botoes.map((b) => (
              <button
                className="botao-msg"
                key={b.rotulo}
                onClick={() => {
                  void b.aoTocar(api);
                }}
              >
                {b.rotulo}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
