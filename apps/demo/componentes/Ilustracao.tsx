/**
 * O que está mockado diz que está mockado, na tela.
 *
 * A demonstração roda sem banco e sem Meta: a conversa do WhatsApp e a oferta da
 * lista de espera são desenhos do que o sistema faz em produção, não um envio de
 * verdade. Escrever isso num comentário não serviria de nada — quem vê a tela
 * precisa ler.
 */
export function Ilustracao({ children }: { children: string }) {
  return (
    <span className="ilustracao" data-testid="ilustracao">
      ilustração
      <span className="ilustracao-nota">{children}</span>
    </span>
  );
}
