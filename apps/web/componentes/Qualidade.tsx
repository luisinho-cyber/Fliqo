import type { LeituraDaQualidade } from '../lib/qualidade';

/**
 * A qualidade do número, em dois estados.
 *
 * Fresca, o valor é o protagonista e a idade vem junto, pequena. Velha, o valor
 * desaparece: o ponto fica neutro e a frase diz que não há leitura recente. A
 * decisão de qual estado é de `lerQualidade`; aqui só se desenha.
 */
const PONTOS = {
  ok: 'bg-ok',
  late: 'bg-late',
  risk: 'bg-risk',
  neutro: 'bg-linha-forte',
} as const;

export function Qualidade({ leitura }: { leitura: LeituraDaQualidade }) {
  if (leitura.estado === 'sem_leitura') {
    return (
      <span className="flex items-center gap-2">
        <Ponto tom="neutro" />
        <span className="text-ink-suave">Qualidade ainda não apurada</span>
      </span>
    );
  }

  if (leitura.estado === 'antiga') {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Ponto tom="neutro" />
        <span>Qualidade sem leitura recente</span>
        <span className="text-ink-suave text-[13px]">
          · última em {leitura.data}, {leitura.idade}
        </span>
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Ponto tom={leitura.tom} />
      <span className="font-semibold">{leitura.rotulo}</span>
      <span className="text-ink-suave text-[13px]">· {leitura.idade}</span>
    </span>
  );
}

function Ponto({ tom }: { tom: keyof typeof PONTOS }) {
  return <span aria-hidden className={`inline-block size-2 rounded-full ${PONTOS[tom]}`} />;
}
