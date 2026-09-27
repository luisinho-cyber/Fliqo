import { redirect } from 'next/navigation';
import { Atualiza } from '../../componentes/Atualiza';
import { Decisoes } from '../../componentes/Decisoes';
import { LinhaDoDia } from '../../componentes/LinhaDoDia';
import { Manchete } from '../../componentes/Manchete';
import { Marca } from '../../componentes/Marca';
import { chamarApi } from '../../lib/api';
import { clinicaEscolhida, tokenDaSessao } from '../../lib/servidor';
import type { ClinicaDaPessoa, Hoje } from '../../lib/tipos';
import { escolherClinica, sair } from '../acoes';

/**
 * A tela Hoje.
 *
 * Tudo acontece no servidor: é ele que tem o cookie, que põe o Bearer no
 * cabeçalho e que fala com a nossa API. O navegador recebe HTML pronto — sem
 * token, sem chave, sem consulta ao banco.
 */

// O dia de hoje não tem versão guardada: cada visita pergunta de novo.
export const dynamic = 'force-dynamic';

export default async function TelaHoje() {
  const token = await tokenDaSessao();
  if (token === undefined) redirect('/login?erro=sessao');

  const clinicas = await chamarApi<ClinicaDaPessoa[]>('/api/minhas-clinicas', { token });
  if (!clinicas.ok) {
    if (clinicas.motivo === 'sem_sessao') redirect('/login?erro=sessao');
    return <Indisponivel />;
  }
  if (clinicas.dados.length === 0) return <SemClinica />;

  const pedida = await clinicaEscolhida();
  // A clínica do cookie só vale se ainda estiver na lista: quem saiu de uma
  // clínica não continua vendo a agenda dela por causa de um cookie velho.
  const clinica = clinicas.dados.find((c) => c.id === pedida) ?? clinicas.dados[0];
  if (clinica === undefined) return <SemClinica />;

  const resposta = await chamarApi<Hoje>('/api/hoje', { token, clinicaId: clinica.id });
  if (!resposta.ok) {
    if (resposta.motivo === 'sem_sessao') redirect('/login?erro=sessao');
    if (resposta.motivo === 'sem_acesso') return <SemAcesso nome={clinica.nome} />;
    return <Indisponivel />;
  }

  const hoje = resposta.dados;
  const agoraMs = Date.parse(hoje.agora);

  return (
    <div className="flex min-h-screen flex-col">
      <Atualiza />
      <header className="bg-paper border-linha flex flex-wrap items-center gap-5 border-b px-5 py-3">
        <Marca />
        <nav className="flex gap-1" aria-label="Seções do painel">
          <span
            aria-current="true"
            className="bg-ink text-paper rounded-full px-3.5 py-1.5 font-semibold"
          >
            Linha do dia
          </span>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {clinicas.dados.length > 1 ? (
            <form action={escolherClinica} className="flex items-center gap-2">
              <label className="text-ink-suave text-[13px]" htmlFor="clinica">
                Clínica
              </label>
              <select
                id="clinica"
                name="clinica"
                defaultValue={clinica.id}
                className="border-linha-forte bg-paper text-ink rounded-[6px] border px-2 py-1 text-[13px]"
              >
                {clinicas.dados.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome}
                  </option>
                ))}
              </select>
              <button type="submit" className="text-petrol text-[13px] font-semibold">
                Trocar
              </button>
            </form>
          ) : (
            <span className="text-ink-suave text-[13px]">{clinica.nome}</span>
          )}
          <form action={sair}>
            <button
              type="submit"
              className="border-linha-forte rounded-full border px-3 py-1 text-[13px] font-semibold"
            >
              Sair
            </button>
          </form>
        </div>
      </header>

      <main className="grid flex-1 items-start gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="bg-paper border-linha min-w-0 rounded-[16px] border p-5">
          <Manchete {...hoje.manchete} />
          {hoje.profissionais.length === 0 ? (
            <DiaVazio />
          ) : (
            <LinhaDoDia
              profissionais={hoje.profissionais}
              consultas={hoje.consultas}
              vagas={hoje.vagas}
              fuso={hoje.fuso}
              agoraMs={agoraMs}
            />
          )}
          <Legenda />
        </section>

        <section className="bg-paper border-linha min-w-0 rounded-[16px] border p-5">
          <h2 className="mb-3 text-base">Decisões de hoje</h2>
          <Decisoes decisoes={hoje.decisoes} />
        </section>
      </main>
    </div>
  );
}

function Legenda() {
  return (
    <p className="text-ink-suave mt-3 text-[12px]">
      Bloco cheio: confirmado. Bloco vazado: aguardando resposta. Borda âmbar e contorno tracejado:
      o horário marcado e onde a consulta deve começar de verdade. Hachura em petróleo: horário
      livre.
    </p>
  );
}

function DiaVazio() {
  return (
    <div className="border-linha rounded-[10px] border border-dashed p-5">
      <p className="font-semibold">Hoje não tem ninguém marcado.</p>
      <p className="text-ink-suave mt-1 text-sm">
        Quando a agenda tiver consulta, o dia de cada profissional aparece aqui como uma faixa.
      </p>
    </div>
  );
}

function SemClinica() {
  return (
    <main className="mx-auto max-w-[520px] px-5 py-12">
      <Marca />
      <h1 className="mt-5 text-2xl">Sua conta ainda não está ligada a uma clínica.</h1>
      <p className="text-ink-suave mt-2 text-sm">
        Peça a quem cuida do sistema para incluir o seu e-mail na equipe da clínica. Assim que isso
        acontecer, o dia de hoje aparece aqui.
      </p>
      <form action={sair} className="mt-5">
        <button type="submit" className="border-linha-forte rounded-full border px-4 py-2 text-sm">
          Sair
        </button>
      </form>
    </main>
  );
}

function SemAcesso({ nome }: { nome: string }) {
  return (
    <main className="mx-auto max-w-[520px] px-5 py-12">
      <Marca />
      <h1 className="mt-5 text-2xl">Você não tem acesso a {nome}.</h1>
      <p className="text-ink-suave mt-2 text-sm">
        Se isso mudou agora há pouco, saia e entre de novo. Se não mudou, fale com quem cuida do
        sistema.
      </p>
      <form action={sair} className="mt-5">
        <button type="submit" className="border-linha-forte rounded-full border px-4 py-2 text-sm">
          Sair
        </button>
      </form>
    </main>
  );
}

function Indisponivel() {
  return (
    <main className="mx-auto max-w-[520px] px-5 py-12">
      <Marca />
      <h1 className="mt-5 text-2xl">Não consegui carregar o dia de hoje.</h1>
      <p className="text-ink-suave mt-2 text-sm">
        A agenda continua no lugar — foi esta tela que não conseguiu falar com o servidor. Atualize
        a página daqui a pouco. Se continuar assim, atenda pelo telefone e avise quem cuida do
        sistema.
      </p>
    </main>
  );
}
