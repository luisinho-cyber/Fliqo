import { tocar } from '../app/acoes';
import { hhmm } from '../lib/linha';
import { primeiroNome } from '../lib/formato';
import type { ConsultaDaTela } from '../lib/tipos';

/**
 * Os três toques: chegou, iniciar, finalizar.
 *
 * Um toque cada, sem formulário e sem confirmação: quem usa isto é a recepção
 * entre um paciente e outro, ou o profissional no celular com luva na mão. O
 * horário é o do servidor — relógio errado no balcão bagunçaria a projeção do
 * dia inteiro.
 *
 * Cada botão é um form com server action: ao tocar, a Linha do Dia e a régua de
 * atraso voltam recalculadas na mesma resposta, sem recarregar a página.
 */
export function Toques({ consultas, fuso }: { consultas: ConsultaDaTela[]; fuso: string }) {
  const abertas = consultas.filter((c) => c.status !== 'cancelado' && c.status !== 'faltou');
  if (abertas.length === 0) return null;

  return (
    <div className="mt-5">
      <h2 className="mb-2 text-base">Atendimentos de hoje</h2>
      <ul className="m-0 list-none p-0" data-testid="toques">
        {abertas.map((c) => (
          <li
            key={c.id}
            className="border-linha flex flex-wrap items-center gap-3 border-t py-2 first:border-t-0"
          >
            <span className="font-mono text-[13px] tabular-nums">
              {hhmm(Date.parse(c.inicioPrevisto), fuso)}
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold">
              {primeiroNome(c.paciente)}{' '}
              <span className="text-ink-suave font-normal">{c.procedimento}</span>
            </span>
            <Estado consulta={c} />
            <div className="flex gap-1">
              {!c.chegou && <Botao consulta={c.id} toque="chegou" rotulo="Chegou" />}
              {c.situacao === 'aguardando' && c.chegou && (
                <Botao consulta={c.id} toque="iniciar" rotulo="Iniciar" />
              )}
              {c.situacao === 'em_atendimento' && (
                <Botao consulta={c.id} toque="finalizar" rotulo="Finalizar" />
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Estado({ consulta }: { consulta: ConsultaDaTela }) {
  if (consulta.situacao === 'finalizada') {
    return <span className="text-ok text-[12px] font-semibold">atendido</span>;
  }
  if (consulta.situacao === 'em_atendimento') {
    return <span className="text-petrol text-[12px] font-semibold">em atendimento</span>;
  }
  if (consulta.chegou) {
    return <span className="text-ink-suave text-[12px]">na recepção</span>;
  }
  return <span className="text-ink-suave text-[12px]">não chegou</span>;
}

function Botao({ consulta, toque, rotulo }: { consulta: string; toque: string; rotulo: string }) {
  return (
    <form action={tocar}>
      <input type="hidden" name="consulta" value={consulta} />
      <input type="hidden" name="toque" value={toque} />
      <button
        type="submit"
        className="border-linha-forte bg-paper rounded-full border px-3 py-1 text-[13px] font-semibold"
      >
        {rotulo}
      </button>
    </form>
  );
}
