/**
 * Planejado × real, desenhado.
 *
 * O mesmo par da Linha do Dia: barra tracejada é o que o cadastro reserva, barra
 * sólida é o que o procedimento leva. A distância entre as duas é a resposta, e
 * ninguém deve precisar ler o número para enxergar — o número está ao lado porque
 * quem vai mexer no cadastro precisa dele, não para explicar o desenho.
 *
 * A escala é comum a toda a lista (`maiorMin`), e não por linha: barra por linha
 * faria uma divergência de cinco minutos parecer igual a uma de quarenta.
 */
export function Medida({
  cadastradaMin,
  realMin,
  maiorMin,
}: {
  cadastradaMin: number;
  realMin: number;
  maiorMin: number;
}) {
  const escala = (min: number) => `${String(Math.max(4, Math.round((min / maiorMin) * 100)))}%`;
  return (
    <span className="medida" aria-hidden="true">
      <span className="planejado" style={{ width: escala(cadastradaMin) }} />
      <span className="real" style={{ width: escala(realMin) }} />
    </span>
  );
}
