import { formatBRL } from '../lib/formato';

/**
 * Uma frase em vez de cards de KPI — a segunda assinatura do DESIGN.md.
 * Os números entram na frase com a cor do que significam.
 */
export function Manchete({
  quantidade,
  naAgendaCents,
  semConfirmacaoCents,
}: {
  quantidade: number;
  naAgendaCents: number;
  semConfirmacaoCents: number;
}) {
  if (quantidade === 0) {
    return (
      <h1 className="font-titulo mb-3 max-w-[46ch] text-[clamp(20px,2.4vw,30px)] font-bold tracking-[-0.03em]">
        Nenhuma consulta marcada para hoje.
      </h1>
    );
  }

  return (
    <h1 className="font-titulo mb-3 max-w-[46ch] text-[clamp(20px,2.4vw,30px)] font-bold tracking-[-0.03em]">
      <span className="font-mono tabular-nums">{quantidade}</span>{' '}
      {quantidade === 1 ? 'consulta' : 'consultas'} hoje,{' '}
      <span className="font-mono tabular-nums">{formatBRL(naAgendaCents)}</span> na agenda.{' '}
      {semConfirmacaoCents > 0 ? (
        <>
          <span className="text-risco font-mono tabular-nums">
            {formatBRL(semConfirmacaoCents)}
          </span>{' '}
          ainda sem confirmação.
        </>
      ) : (
        <span className="text-ok">Tudo confirmado.</span>
      )}
    </h1>
  );
}
