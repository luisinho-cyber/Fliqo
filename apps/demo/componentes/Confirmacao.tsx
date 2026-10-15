'use client';

import { PROCEDIMENTOS, type ConfirmacaoDemo, type ConsultaDemo } from '../nucleo/dados';
import { hhmm, instanteDe } from '../nucleo/relogio';
import { Ilustracao } from './Ilustracao';

/**
 * A confirmação de véspera, pelo WhatsApp: quem respondeu que vem, quem
 * respondeu que não vem e quem não respondeu nada.
 *
 * Quem não respondeu é a linha que importa, e por isso ela não é um estado
 * neutro na tabela: silêncio não é cancelamento (CLAUDE.md, regra 5). O horário
 * continua marcado, e a tela diz isso com essas palavras — tirar da agenda quem
 * ficou quieto produz paciente chegando para um horário dado a outro.
 */

const ROTULO: Record<ConfirmacaoDemo['estado'], { texto: string; classe: string }> = {
  confirmou: { texto: 'respondeu que vem', classe: 'ok' },
  recusou: { texto: 'respondeu que não vem', classe: 'risco' },
  semResposta: { texto: 'não respondeu', classe: 'neutro' },
  aguardando: { texto: 'aguardando resposta', classe: 'neutro' },
};

interface Props {
  consultas: ConsultaDemo[];
  confirmacoes: ConfirmacaoDemo[];
  inicioDoDia: Date;
  conversaAtiva: string;
  aoAbrir: (consultaId: string) => void;
}

export function Confirmacao({
  consultas,
  confirmacoes,
  inicioDoDia,
  conversaAtiva,
  aoAbrir,
}: Props) {
  const linhas = confirmacoes
    .map((f) => ({ f, c: consultas.find((x) => x.id === f.consultaId) }))
    .filter((l): l is { f: ConfirmacaoDemo; c: ConsultaDemo } => l.c !== undefined);

  const semResposta = linhas.filter(
    (l) => l.f.estado === 'semResposta' || l.f.estado === 'aguardando',
  ).length;

  return (
    <div data-testid="confirmacao">
      <div className="secao-cab">
        <h2>Confirmação no WhatsApp</h2>
        <Ilustracao>a demonstração não envia mensagem: nada aqui sai para a Meta</Ilustracao>
      </div>

      <p className="apoio" data-testid="resumo-confirmacao">
        {semResposta === 0
          ? 'Todo mundo de hoje respondeu.'
          : `${String(semResposta)} ${semResposta === 1 ? 'paciente' : 'pacientes'} sem resposta. O horário continua marcado: silêncio não é cancelamento.`}
      </p>

      <div className="tabela-rolagem">
        <table className="tabela">
          <caption className="sr">Confirmações de hoje</caption>
          <thead>
            <tr>
              <th scope="col">Paciente</th>
              <th scope="col">Procedimento</th>
              <th scope="col">Marcado</th>
              <th scope="col">Resposta</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map(({ f, c }) => {
              const marca = ROTULO[f.estado];
              return (
                <tr
                  key={c.id}
                  aria-current={conversaAtiva === c.id ? 'true' : undefined}
                  data-testid={`confirmacao-${c.id}`}
                >
                  <td>
                    <button
                      className="linha-abrir"
                      onClick={() => {
                        aoAbrir(c.id);
                      }}
                    >
                      {c.paciente}
                    </button>
                  </td>
                  <td>{PROCEDIMENTOS[c.procedimentoId]?.nome ?? '—'}</td>
                  <td className="mono num">{hhmm(instanteDe(inicioDoDia, c.marcadaEm))}</td>
                  <td>
                    <span className={`estado ${marca.classe}`}>{marca.texto}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
