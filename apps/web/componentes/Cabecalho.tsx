import { escolherClinica, sair } from '../app/acoes';
import type { ClinicaDaPessoa } from '../lib/tipos';
import { Abas } from './Abas';
import { Marca } from './Marca';

export function Cabecalho({
  atual,
  clinica,
  clinicas,
}: {
  atual: string;
  clinica: ClinicaDaPessoa;
  clinicas: ClinicaDaPessoa[];
}) {
  return (
    <header className="bg-paper border-fio flex flex-wrap items-center gap-5 border-b px-5 py-3">
      <Marca />
      <Abas atual={atual} papel={clinica.papel} modoConvidado={clinica.modoConvidado} />
      <div className="ml-auto flex items-center gap-3">
        {clinicas.length > 1 ? (
          <form action={escolherClinica} className="flex items-center gap-2">
            <label className="text-ink-2 text-[13px]" htmlFor="clinica">
              Clínica
            </label>
            <select
              id="clinica"
              name="clinica"
              defaultValue={clinica.id}
              className="border-fio bg-paper text-ink rounded-sm border px-2 py-1 text-[13px]"
            >
              {clinicas.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.nome}
                </option>
              ))}
            </select>
            <button type="submit" className="text-marca text-[13px] font-semibold">
              Trocar
            </button>
          </form>
        ) : (
          <span className="text-ink-2 text-[13px]">{clinica.nome}</span>
        )}
        <form action={sair}>
          <button
            type="submit"
            className="border-fio rounded-pill border px-3 py-1 text-[13px] font-semibold"
          >
            Sair
          </button>
        </form>
      </div>
    </header>
  );
}
