/**
 * Planejado × real, desenhado.
 *
 * O mesmo par em toda tela: barra vazada tracejada é o que foi planejado, barra cheia é
 * o que aconteceu. A distância entre as duas é a resposta, e ninguém deve precisar ler o
 * número para enxergar — o número está ao lado porque quem vai agir precisa dele, não
 * para explicar o desenho.
 *
 * Os nomes dos parâmetros são neutros de propósito: o mesmo componente compara duração
 * cadastrada com mediana real na Pontualidade, e marcado com esperado no Caixa. Nome de
 * minuto numa tela de dinheiro mentiria — e é o tipo de mentira que ninguém percebe até
 * precisar mexer.
 *
 * A escala é comum a toda a lista (`maior`), e não por linha: barra por linha faria uma
 * divergência pequena parecer igual a uma grande.
 */
export function Medida({
  planejado,
  real,
  maior,
}: {
  planejado: number;
  real: number;
  maior: number;
}) {
  const escala = (v: number) => `${String(Math.max(4, Math.round((v / maior) * 100)))}%`;
  return (
    <span className="medida" aria-hidden="true">
      <span className="planejado" style={{ width: escala(planejado) }} />
      <span className="real" style={{ width: escala(real) }} />
    </span>
  );
}
