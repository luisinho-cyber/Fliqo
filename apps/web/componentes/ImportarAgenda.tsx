'use client';

import { adivinharMapa, descobrirSeparador, separarCampos, type MapaDeColunas } from '@fliqo/core';
import { useState } from 'react';
import { importarAgenda } from '../app/acoes';
import type { RelatorioDaImportacao } from '../lib/tipos';

/**
 * Importação com mapeamento de colunas feito na tela.
 *
 * O navegador lê o arquivo para poder MOSTRAR os cabeçalhos — é a única forma de a
 * clínica dizer qual coluna é qual sem a gente exigir um formato. Quem separa os
 * campos de verdade, valida e grava é o servidor, a partir do mesmo texto: o palpite
 * daqui é conveniência, não autoridade.
 *
 * Nada é guardado entre os dois passos. O arquivo fica no navegador até o envio, e
 * vai junto com o mapeamento numa chamada só — sem área de staging, sem arquivo
 * nosso em disco nenhum.
 */

const CAMPOS: { campo: keyof MapaDeColunas; rotulo: string; ajuda: string }[] = [
  { campo: 'paciente', rotulo: 'Paciente', ajuda: 'o nome de quem vai ser atendido' },
  {
    campo: 'telefone',
    rotulo: 'Telefone',
    ajuda: 'celular com DDD; é por ele que o paciente é reconhecido',
  },
  { campo: 'profissional', rotulo: 'Profissional', ajuda: 'quem atende' },
  { campo: 'inicio', rotulo: 'Início', ajuda: 'data e hora, como 05/10/2026 14:00' },
  { campo: 'procedimento', rotulo: 'Procedimento', ajuda: 'o que vai ser feito' },
];

type Estado =
  | { fase: 'escolher' }
  | { fase: 'mapear'; arquivo: string; texto: string; cabecalho: string[]; exemplo: string[][] }
  | { fase: 'enviando' }
  | { fase: 'pronto'; relatorio: RelatorioDaImportacao }
  | { fase: 'erro'; mensagem: string };

const ERROS: Record<string, string> = {
  planilha_sem_linhas: 'O arquivo não tem nenhuma linha de agenda depois do cabeçalho.',
  planilha_grande_demais:
    'O arquivo tem linhas demais para uma importação só. Divida em dois e mande um de cada vez — reimportar não duplica nada.',
  apenas_dono_importa_agenda: 'Só quem é dono da clínica pode importar a agenda.',
  indisponivel:
    'Não consegui falar com o servidor. A agenda que já estava na Fliqo continua intacta — nada foi importado pela metade.',
};

export function ImportarAgenda() {
  const [estado, setEstado] = useState<Estado>({ fase: 'escolher' });
  const [mapa, setMapa] = useState<Partial<MapaDeColunas>>({});
  const [temCabecalho, setTemCabecalho] = useState(true);

  async function escolherArquivo(arquivo: File) {
    const texto = await arquivo.text();
    const linhas = separarCampos(texto, descobrirSeparador(texto));
    const cabecalho = linhas[0] ?? [];
    if (cabecalho.length === 0) {
      setEstado({ fase: 'erro', mensagem: 'Não consegui ler nenhuma coluna neste arquivo.' });
      return;
    }
    setMapa(adivinharMapa(cabecalho));
    setEstado({
      fase: 'mapear',
      arquivo: arquivo.name,
      texto,
      cabecalho,
      exemplo: linhas.slice(1, 4),
    });
  }

  async function enviar(texto: string, arquivo: string) {
    const completo = CAMPOS.every(({ campo }) => mapa[campo] !== undefined);
    if (!completo) return;
    setEstado({ fase: 'enviando' });
    const r = await importarAgenda({ arquivo, texto, mapa: mapa as MapaDeColunas, temCabecalho });
    setEstado(
      r.ok
        ? { fase: 'pronto', relatorio: r.relatorio }
        : { fase: 'erro', mensagem: ERROS[r.erro] ?? 'Não consegui importar este arquivo.' },
    );
  }

  if (estado.fase === 'pronto') {
    return (
      <Relatorio
        relatorio={estado.relatorio}
        aoRecomecar={() => {
          setEstado({ fase: 'escolher' });
        }}
      />
    );
  }

  return (
    <div>
      {estado.fase === 'erro' ? (
        <p className="border-risco bg-risco-tinta mb-4 rounded-md border px-4 py-3 text-sm">
          {estado.mensagem}
        </p>
      ) : null}

      {estado.fase === 'mapear' ? (
        <div>
          <p className="text-ink-2 text-sm">
            Arquivo <span className="font-mono">{estado.arquivo}</span>. Diga qual coluna é cada
            coisa — cada sistema exporta de um jeito, então nada é adivinhado sozinho.
          </p>

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={temCabecalho}
              onChange={(e) => {
                setTemCabecalho(e.target.checked);
              }}
            />
            A primeira linha é o cabeçalho, e não uma consulta
          </label>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {CAMPOS.map(({ campo, rotulo, ajuda }) => (
              <div key={campo}>
                <label className="block text-[13px] font-semibold" htmlFor={`col-${campo}`}>
                  {rotulo}
                </label>
                <select
                  id={`col-${campo}`}
                  value={mapa[campo] ?? ''}
                  onChange={(e) => {
                    setMapa((m) => ({
                      ...m,
                      [campo]: e.target.value === '' ? undefined : Number(e.target.value),
                    }));
                  }}
                  className="border-fio bg-paper text-ink mt-1 w-full rounded-sm border px-2 py-1.5 text-sm"
                >
                  <option value="">escolha a coluna</option>
                  {estado.cabecalho.map((titulo, i) => (
                    <option key={`${titulo}-${String(i)}`} value={i}>
                      {titulo === '' ? `coluna ${String(i + 1)}` : titulo}
                    </option>
                  ))}
                </select>
                <p className="text-ink-2 mt-1 text-[12px]">{ajuda}</p>
              </div>
            ))}
          </div>

          <Previa cabecalho={estado.cabecalho} exemplo={estado.exemplo} mapa={mapa} />

          <button
            type="button"
            disabled={!CAMPOS.every(({ campo }) => mapa[campo] !== undefined)}
            onClick={() => {
              void enviar(estado.texto, estado.arquivo);
            }}
            className="bg-ink text-paper rounded-pill mt-5 px-4 py-2 text-sm font-semibold disabled:opacity-100 disabled:grayscale"
          >
            Importar esta agenda
          </button>
          <p className="text-ink-2 mt-2 text-[12px]">
            Importar o mesmo arquivo duas vezes não duplica consulta. Pode mandar sem medo.
          </p>
        </div>
      ) : (
        <div>
          <input
            type="file"
            accept=".csv,.txt,.tsv,text/csv,text/plain,text/tab-separated-values"
            disabled={estado.fase === 'enviando'}
            onChange={(e) => {
              const arquivo = e.target.files?.[0];
              if (arquivo !== undefined) void escolherArquivo(arquivo);
            }}
            className="border-fio rounded-sm border px-3 py-2 text-sm"
          />
          <p className="text-ink-2 mt-2 text-sm">
            Vale CSV separado por ponto e vírgula, vírgula ou tabulação — é o que sai de
            &quot;Exportar&quot; ou &quot;Salvar como CSV&quot; em qualquer sistema. Planilha em
            .xlsx precisa ser salva como CSV antes.
          </p>
          {estado.fase === 'enviando' ? <p className="mt-3 text-sm">Lendo a agenda…</p> : null}
        </div>
      )}
    </div>
  );
}

/** As primeiras linhas lidas com o mapeamento atual: erro de coluna aparece aqui, antes de gravar. */
function Previa({
  cabecalho,
  exemplo,
  mapa,
}: {
  cabecalho: string[];
  exemplo: string[][];
  mapa: Partial<MapaDeColunas>;
}) {
  if (exemplo.length === 0) return null;
  return (
    <div className="mt-5">
      <h3 className="text-[13px] font-semibold">Como as primeiras linhas vão ser lidas</h3>
      <table className="mt-2 w-full text-[13px]">
        <thead>
          <tr className="text-ink-2 border-fio border-b text-left">
            {CAMPOS.map(({ campo, rotulo }) => (
              <th key={campo} className="py-1.5 font-semibold">
                {rotulo}
                <span className="text-ink-2 block font-normal">
                  {mapa[campo] === undefined ? '—' : cabecalho[mapa[campo]]}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {exemplo.map((linha, i) => (
            <tr key={i} className="border-fio border-b last:border-b-0">
              {CAMPOS.map(({ campo }) => (
                <td key={campo} className="py-1.5">
                  {mapa[campo] === undefined ? '' : (linha[mapa[campo]] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** As frases dos motivos. Motivo sem frase vira "erro desconhecido", que não conserta nada. */
const MOTIVOS: Record<string, string> = {
  colunas_de_menos: 'a linha tem menos colunas do que o cabeçalho',
  sem_paciente: 'sem nome de paciente',
  telefone_invalido: 'telefone que não dá para discar',
  sem_profissional: 'sem profissional',
  data_invalida: 'data ou hora que não deu para ler',
  sem_procedimento: 'sem procedimento',
  horario_ocupado: 'esse horário já é de outro paciente na Fliqo',
};

function Relatorio({
  relatorio,
  aoRecomecar,
}: {
  relatorio: RelatorioDaImportacao;
  aoRecomecar: () => void;
}) {
  const r = relatorio;
  return (
    <div>
      <p className="text-base">
        <span className="font-mono font-semibold">{r.entraram}</span> consultas entraram de{' '}
        <span className="font-mono">{r.total}</span> linhas.
        {r.repetidas > 0 ? (
          <>
            {' '}
            <span className="font-mono">{r.repetidas}</span> já estavam na agenda e ficaram como
            estavam.
          </>
        ) : null}
        {r.recusadas > 0 ? (
          <>
            {' '}
            <span className="font-mono">{r.recusadas}</span> foram recusadas, e cada uma está abaixo
            com o motivo.
          </>
        ) : null}
      </p>

      {r.recusas.length === 0 ? (
        <p className="text-ink-2 mt-2 text-sm">Nenhuma linha ficou de fora.</p>
      ) : (
        <>
          <h3 className="mt-5 text-base">Linhas recusadas</h3>
          <p className="text-ink-2 mt-1 text-sm">
            O número é o da linha no seu arquivo. Conserte lá e importe de novo: o que já entrou não
            entra duas vezes.
          </p>
          <ul className="mt-3">
            {r.recusas.map((l) => (
              <li
                key={`${String(l.linha)}-${l.motivo}`}
                className="border-fio flex flex-wrap items-baseline gap-x-3 border-b py-2 text-sm last:border-b-0"
              >
                <span className="font-mono">linha {l.linha}</span>
                <span className="font-semibold">{l.rotulo === '' ? 'sem nome' : l.rotulo}</span>
                <span className="text-ink-2">{MOTIVOS[l.motivo] ?? l.motivo}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <button
        type="button"
        onClick={() => {
          aoRecomecar();
        }}
        className="border-fio rounded-pill mt-5 border px-4 py-2 text-sm font-semibold"
      >
        Importar outro arquivo
      </button>
    </div>
  );
}
