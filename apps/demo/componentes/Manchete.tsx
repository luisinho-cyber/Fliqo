import { brl, manchete } from '../nucleo/calculos';
import type { ConsultaDemo } from '../nucleo/dados';
import type { Dia } from '../nucleo/estado';

/**
 * Uma frase em vez de cards de KPI — a segunda assinatura do DESIGN.md.
 * Os números entram na frase com a cor do que significam.
 */
export function Manchete({ consultas, dia }: { consultas: ConsultaDemo[]; dia: Dia }) {
  const m = manchete(consultas, dia);
  const quando = dia === 'hoje' ? 'hoje' : 'amanhã';

  return (
    <h1 className="manchete" data-testid="manchete">
      <span className="n">{m.quantidade}</span> consultas {quando},{' '}
      <span className="n">{brl(m.naAgenda)}</span> na agenda.{' '}
      {m.semConfirmacao > 0 ? (
        <>
          <span className="n risco">{brl(m.semConfirmacao)}</span> ainda sem confirmação.
        </>
      ) : (
        <span className="ok">Tudo confirmado.</span>
      )}
    </h1>
  );
}
