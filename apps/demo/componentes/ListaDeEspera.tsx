import { brl } from '../nucleo/calculos';
import { PROCEDIMENTOS, type EsperaDemo } from '../nucleo/dados';

const ROTULO: Record<EsperaDemo['estado'], { texto: string; classe: string }> = {
  aguardando: { texto: 'aguardando', classe: 'petrol' },
  ofertado: { texto: 'oferta enviada', classe: 'late' },
  atendido: { texto: 'ficou com a vaga', classe: 'ok' },
  preenchido_por_outro: { texto: 'segue na fila', classe: 'petrol' },
};

/**
 * A fila só vira dinheiro quando uma vaga abre. A tela mostra por quanto tempo
 * cada pessoa espera e quanto vale o procedimento que ela quer.
 */
export function ListaDeEspera({ fila }: { fila: EsperaDemo[] }) {
  if (fila.length === 0) {
    return (
      <div data-testid="lista-de-espera">
        <h2>Lista de espera</h2>
        <p style={{ color: 'var(--ink-suave)', fontSize: 14 }}>
          Ninguém na lista. Quando um horário cheio for recusado, o paciente entra aqui.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="lista-de-espera">
      <h2>Lista de espera</h2>
      <p style={{ color: 'var(--ink-suave)', fontSize: 14, marginTop: 4 }}>
        Quando um horário abre, a oferta vai para as primeiras da fila ao mesmo tempo. Quem
        responder primeiro fica com ele.
      </p>

      <div className="tabela">
        <table>
          <thead>
            <tr>
              <th>Paciente</th>
              <th>Procedimento</th>
              <th>Na fila</th>
              <th>Situação</th>
              <th className="num">Valor</th>
            </tr>
          </thead>
          <tbody>
            {fila.map((w) => {
              const proc = PROCEDIMENTOS[w.procedimentoId];
              const marca = ROTULO[w.estado];
              return (
                <tr key={w.id} data-testid={`espera-${w.id}`}>
                  <td>
                    {w.paciente}
                    {w.prioridade > 0 && (
                      <span style={{ color: 'var(--ink-suave)' }}>
                        {' '}
                        · remarcou por cancelamento
                      </span>
                    )}
                  </td>
                  <td>{proc?.nome ?? '—'}</td>
                  <td style={{ color: 'var(--ink-suave)' }}>{w.desde}</td>
                  <td>
                    <span className={`etq ${marca.classe}`}>{marca.texto}</span>
                  </td>
                  <td className="num">{brl(proc?.precoCentavos ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
