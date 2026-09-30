import { reenviarConfirmacao, revelarTelefone } from '../app/acoes';
import { hhmm } from '../lib/linha';
import { primeiroNome } from '../lib/formato';
import type { DescarteDaTela } from '../lib/tipos';

/**
 * O que a queda de WhatsApp descartou — como decisão, não como relatório.
 *
 * Um número não é acionável: "13 descartadas" conta à recepção que algo ruim
 * aconteceu e não diz o que fazer. A lista diz: são estes, e cada linha tem uma
 * ação. É a mesma coisa que a Fliqo promete no resto do produto — transformar o
 * que se perdeu numa ação, em vez de num aviso.
 *
 * Duas ações, e o corte entre elas vem do servidor: enquanto a afirmação do
 * template ainda vale, a mensagem resolve sozinha e não gasta ninguém; quando
 * venceu, não há mensagem possível e só resta o telefone.
 *
 * O número aparece MASCARADO. Tocar em "Ligar" é o ato deliberado que revela o
 * inteiro (DESIGN.md), e é o único caminho por onde ele sai.
 */
export function Descartes({
  descartes,
  fuso,
  reveladoDe,
  telefoneRevelado,
}: {
  descartes: DescarteDaTela[];
  fuso: string;
  reveladoDe?: string | undefined;
  telefoneRevelado?: string | undefined;
}) {
  if (descartes.length === 0) return null;

  const quantos = descartes.length;
  return (
    <section className="bg-paper mt-5 rounded-lg p-5" data-testid="descartes">
      <h2 className="font-titulo mb-1 text-base tracking-[-0.02em]">
        {quantos === 1
          ? '1 consulta de hoje não foi confirmada por causa da queda'
          : `${String(quantos)} consultas de hoje não foram confirmadas por causa da queda`}
      </h2>
      <p className="text-ink-2 mb-3 max-w-[60ch] text-[13px]">
        O WhatsApp da clínica ficou fora do ar e estas mensagens venceram antes de poder sair. Quem
        ainda dá tempo de avisar recebe a confirmação agora; para os outros, só o telefone resolve.
      </p>

      <ul className="m-0 list-none p-0">
        {descartes.map((d) => (
          <li
            key={d.acaoId}
            className="border-fio flex flex-wrap items-center gap-3 border-t py-2 first:border-t-0"
          >
            <span className="font-mono text-[13px] tabular-nums">
              {d.inicio === null ? '—' : hhmm(Date.parse(d.inicio), fuso)}
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold">
              {d.paciente === null ? 'paciente sem cadastro' : primeiroNome(d.paciente)}
            </span>

            {d.acao === 'reenviar' ? (
              <form action={reenviarConfirmacao}>
                <input type="hidden" name="acao" value={d.acaoId} />
                <button
                  type="submit"
                  className="border-fio bg-paper rounded-pill border px-3 py-1 text-[13px] font-semibold"
                >
                  Enviar confirmação agora
                </button>
              </form>
            ) : (
              <Ligar
                descarte={d}
                revelado={reveladoDe === d.pacienteId}
                telefone={telefoneRevelado}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Antes do toque, o número mascarado e um botão. Depois, o número inteiro como
 * `tel:` — no celular o toque manda para o discador; no computador ele fica na
 * linha, e a revelação é o ato.
 */
function Ligar({
  descarte,
  revelado,
  telefone,
}: {
  descarte: DescarteDaTela;
  revelado: boolean;
  telefone?: string | undefined;
}) {
  if (revelado && telefone !== undefined) {
    return (
      <a
        href={`tel:${telefone}`}
        className="text-marca-viva font-mono text-[13px] font-semibold tabular-nums"
      >
        {telefone}
      </a>
    );
  }

  if (descarte.pacienteId === null) {
    return <span className="text-ink-2 text-[13px]">sem telefone no cadastro</span>;
  }

  return (
    <form action={revelarTelefone} className="flex items-center gap-2">
      <span className="text-ink-2 font-mono text-[12px] tabular-nums">
        {descarte.telefoneMascarado ?? '—'}
      </span>
      <input type="hidden" name="paciente" value={descarte.pacienteId} />
      <button
        type="submit"
        className="border-fio bg-paper rounded-pill border px-3 py-1 text-[13px] font-semibold"
      >
        Ligar
      </button>
    </form>
  );
}
