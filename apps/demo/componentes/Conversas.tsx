import type { Conversa } from '../nucleo/estado';

/**
 * A recepção vê todas as conversas em um lugar só, e vê logo de cara quais
 * saíram da assistente e estão esperando uma pessoa.
 */
export function Conversas({
  conversas,
  ativa,
  aoAbrir,
}: {
  conversas: Record<string, Conversa>;
  ativa: string;
  aoAbrir: (chave: string) => void;
}) {
  const linhas = Object.entries(conversas);
  const esperandoGente = linhas.filter(([, c]) => c.modo === 'humano').length;

  return (
    <div data-testid="conversas">
      <h2>Conversas</h2>
      <p style={{ color: 'var(--ink-suave)', fontSize: 14, marginTop: 4 }}>
        {esperandoGente === 0
          ? 'Nenhuma conversa esperando por alguém da equipe.'
          : `${String(esperandoGente)} conversa${esperandoGente > 1 ? 's' : ''} esperando por alguém da equipe.`}
      </p>

      <div className="tabela">
        <table>
          <thead>
            <tr>
              <th>Paciente</th>
              <th>Assunto</th>
              <th>Atendida por</th>
              <th className="num">Mensagens</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map(([chave, c]) => (
              <tr
                key={chave}
                onClick={() => {
                  aoAbrir(chave);
                }}
                style={{
                  cursor: 'pointer',
                  fontWeight: chave === ativa ? 700 : 400,
                }}
                data-testid={`conversa-${chave}`}
              >
                <td>{c.paciente}</td>
                <td style={{ color: 'var(--ink-suave)' }}>{c.contexto}</td>
                <td>
                  {c.modo === 'humano' ? (
                    <span className="etq risk">recepção</span>
                  ) : (
                    <span className="etq petrol">Assistente Fliqo</span>
                  )}
                </td>
                <td className="num">{c.mensagens.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
