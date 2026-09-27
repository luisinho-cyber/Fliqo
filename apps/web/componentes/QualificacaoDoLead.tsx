import { salvarQualificacao } from '../app/acoes';
import type { FichaDaConversa } from '../lib/tipos';

/**
 * A ficha do lead, ao lado da conversa.
 *
 * Metade é leitura derivada do que já existe — quem escreveu primeiro, os
 * convênios do cadastro da clínica, o motivo do handover. A outra metade é o
 * que a recepção sabe e o sistema não tem como adivinhar: interesse, faixa de
 * orçamento e a leitura de quem atendeu.
 *
 * A assistente não escreve nada aqui ainda.
 */

const FAIXAS = [
  { valor: '', rotulo: 'Não perguntei' },
  { valor: 'nao_informado', rotulo: 'Não quis dizer' },
  { valor: 'ate_1k', rotulo: 'Até R$ 1.000' },
  { valor: 'de_1k_a_3k', rotulo: 'R$ 1.000 a R$ 3.000' },
  { valor: 'de_3k_a_10k', rotulo: 'R$ 3.000 a R$ 10.000' },
  { valor: 'acima_10k', rotulo: 'Acima de R$ 10.000' },
] as const;

const ORIGEM = {
  paciente: 'O paciente escreveu primeiro',
  clinica: 'A clínica começou o contato',
  desconhecida: 'Sem mensagem ainda',
} as const;

export function QualificacaoDoLead({ ficha }: { ficha: FichaDaConversa }) {
  const q = ficha.qualificacao;
  const proxima = ficha.proximasConsultas[0];

  return (
    <aside className="bg-paper border-linha min-w-0 rounded-[16px] border p-5" data-testid="ficha">
      <h2 className="mb-3 text-base">Sobre este lead</h2>

      <dl className="m-0 text-[13px]">
        <Linha rotulo="Origem">
          {ORIGEM[q.origem.quem]}
          {q.origem.em !== null && (
            <span className="text-ink-suave">
              {' '}
              em {new Date(q.origem.em).toLocaleDateString('pt-BR')}
            </span>
          )}
        </Linha>

        <Linha rotulo="Urgência">
          {q.urgencia.nivel === 'alta' ? (
            <span className="text-risk font-semibold">Alta</span>
          ) : (
            'Normal'
          )}
          {q.urgencia.motivo !== null && (
            <span className="text-ink-suave"> · {q.urgencia.motivo}</span>
          )}
        </Linha>

        <Linha rotulo="Convênios da clínica">
          {q.conveniosDaClinica.length === 0
            ? 'Somente particular'
            : q.conveniosDaClinica.join(', ')}
        </Linha>

        <Linha rotulo="Consentimento de WhatsApp">
          {ficha.paciente.temConsentimento ? 'Sim' : 'Ainda não'}
        </Linha>

        {proxima !== undefined && (
          <Linha rotulo="Próxima consulta">
            {new Date(proxima.inicio).toLocaleString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Linha>
        )}
      </dl>

      <form action={salvarQualificacao} className="border-linha mt-4 border-t pt-4">
        <input type="hidden" name="conversa" value={ficha.id} />

        <label className="mb-3 block">
          <span className="text-ink-suave mb-1 block text-[13px]">O que a pessoa quer</span>
          <input
            name="interesse"
            defaultValue={q.interesse ?? ''}
            maxLength={200}
            placeholder="harmonização, clareamento…"
            className="border-linha-forte bg-paper text-ink w-full rounded-[6px] border px-2 py-1.5 text-[13px]"
          />
        </label>

        <label className="mb-3 block">
          <span className="text-ink-suave mb-1 block text-[13px]">Faixa de orçamento</span>
          <select
            name="faixaDeOrcamento"
            defaultValue={q.faixaDeOrcamento ?? ''}
            className="border-linha-forte bg-paper text-ink w-full rounded-[6px] border px-2 py-1.5 text-[13px]"
          >
            {FAIXAS.map((f) => (
              <option key={f.valor} value={f.valor}>
                {f.rotulo}
              </option>
            ))}
          </select>
        </label>

        <label className="mb-3 block">
          <span className="text-ink-suave mb-1 block text-[13px]">Sua leitura</span>
          <textarea
            name="observacao"
            defaultValue={q.observacao ?? ''}
            maxLength={1000}
            rows={3}
            placeholder="o que ajudaria quem for atender depois de você"
            className="border-linha-forte bg-paper text-ink w-full rounded-[6px] border px-2 py-1.5 text-[13px]"
          />
        </label>

        <button
          type="submit"
          className="bg-ink text-paper w-full rounded-full px-3 py-2 text-[13px] font-semibold"
        >
          Salvar
        </button>
        {q.atualizadoEm !== null && (
          <p className="text-ink-suave mt-2 text-[12px]">
            Atualizado em {new Date(q.atualizadoEm).toLocaleString('pt-BR')}
          </p>
        )}
      </form>
    </aside>
  );
}

function Linha({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="border-linha border-t py-2 first:border-t-0">
      <dt className="text-ink-suave text-[12px]">{rotulo}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}
