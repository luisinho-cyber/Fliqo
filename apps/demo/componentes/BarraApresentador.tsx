import type { Cena } from '../nucleo/roteiro';

/**
 * A barra de quem apresenta. Fica fora do produto de propósito: é o único
 * elemento da tela que não existiria na clínica.
 */
export function BarraApresentador({
  cenas,
  atual,
  escondida,
  aoAvancar,
  aoRecomecar,
  aoIrPara,
}: {
  cenas: Cena[];
  atual: number;
  escondida: boolean;
  aoAvancar: () => void;
  aoRecomecar: () => void;
  aoIrPara: (i: number) => void;
}) {
  const proxima = cenas[atual];
  const feita = atual >= cenas.length;

  return (
    <div
      className={`apresentador${escondida ? ' escondida' : ''}`}
      data-testid="apresentador"
      aria-label="Barra de apresentação"
    >
      <span className="conta">
        {Math.min(atual + 1, cenas.length)}/{cenas.length}
      </span>

      <div className="pontos">
        {cenas.map((c, i) => (
          <button
            key={c.titulo}
            className={i === atual ? 'on' : i < atual ? 'feita' : ''}
            aria-label={`Ir para a cena ${String(i + 1)}: ${c.titulo}`}
            onClick={() => {
              aoIrPara(i);
            }}
          />
        ))}
      </div>

      <div className="texto">
        <strong>{feita ? 'Fim da apresentação' : (proxima?.titulo ?? '')}</strong>
        <span>
          {feita
            ? 'Recomece quando quiser, ou navegue pelas abas à vontade.'
            : (proxima?.descricao ?? '')}
        </span>
      </div>

      <button className="p-btn" onClick={aoAvancar} disabled={feita} data-testid="avancar">
        {atual === 0 ? 'Começar' : 'Avançar'}
        <span className="kbd">→</span>
      </button>
      <button className="p-btn sec" onClick={aoRecomecar} data-testid="recomecar">
        Recomeçar
        <span className="kbd">R</span>
      </button>
    </div>
  );
}
