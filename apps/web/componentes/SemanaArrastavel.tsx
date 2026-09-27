'use client';

import { useRef, useState } from 'react';
import { hhmm } from '../lib/linha';
import { primeiroNome } from '../lib/formato';
import type { DiaDaSemana, ProfissionalDaTela } from '../lib/tipos';

/**
 * A semana por profissional, com arraste para remarcar.
 *
 * O arraste é conveniência, não o único caminho: o formulário abaixo da grade
 * faz a mesma coisa sem JavaScript e no celular, onde arrastar num grid de sete
 * colunas é briga. Quem tem luva na mão precisa de um caminho que funcione.
 *
 * Soltar o bloco não decide nada: manda o pedido para a nossa API. Se o horário
 * foi ocupado no meio do caminho, ela devolve 409 e a consulta original fica
 * intacta — quem decide isso é a constraint no banco (CLAUDE.md, regra 3).
 */

const DIAS_CURTOS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];

interface Props {
  dias: DiaDaSemana[];
  profissionais: ProfissionalDaTela[];
  fuso: string;
  /** A server action de remarcar. Roda no servidor; o React cuida da espera. */
  aoSoltar: (consultaId: string, novoInicio: string) => Promise<void>;
}

export function SemanaArrastavel({ dias, profissionais, fuso, aoSoltar }: Props) {
  const [arrastando, setArrastando] = useState<string | null>(null);
  const origem = useRef<{ id: string; inicio: string } | null>(null);

  return (
    <div className="overflow-x-auto" data-testid="semana">
      <div className="min-w-[760px]">
        <div className="mb-2 grid grid-cols-7 gap-2">
          {dias.map((d, i) => (
            <div key={d.dataIso} className="text-[12px]">
              <b className={d.ehHoje ? 'text-late' : ''}>{DIAS_CURTOS[i]}</b>{' '}
              <span className="text-ink-suave font-mono tabular-nums">
                {d.dataIso.slice(8, 10)}/{d.dataIso.slice(5, 7)}
              </span>
            </div>
          ))}
        </div>

        {profissionais.map((prof) => (
          <div key={prof.id} className="mb-5">
            <div className="mb-1 flex items-baseline justify-between">
              <b className="font-titulo tracking-[-0.02em]">{prof.nome}</b>
              {prof.atrasoMin >= 10 && (
                // O atraso vale só para hoje: é o efeito cascata do dia que está
                // acontecendo, não uma previsão para a semana.
                <span className="text-late text-[12px]">
                  hoje com cerca de {String(Math.round(prof.atrasoMin / 5) * 5)} min de atraso
                </span>
              )}
            </div>

            <div className="grid grid-cols-7 gap-2">
              {dias.map((dia) => {
                const dele = dia.consultas.filter((c) => c.profissionalId === prof.id);
                const vagasDele = dia.vagas.filter((v) => v.profissionalId === prof.id);
                return (
                  <div
                    key={dia.dataIso}
                    className={`border-linha min-h-[110px] rounded-[10px] border p-1 ${
                      dia.ehHoje ? 'border-late' : ''
                    }`}
                    onDragOver={(e) => {
                      e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const atual = origem.current;
                      setArrastando(null);
                      if (atual === null) return;
                      // Mesmo horário, outro dia: o que o arraste muda é a data.
                      const hora = new Date(atual.inicio);
                      const [ano, mes, d] = dia.dataIso.split('-').map(Number);
                      const novo = new Date(hora);
                      novo.setFullYear(ano ?? 0, (mes ?? 1) - 1, d ?? 1);
                      if (novo.getTime() === hora.getTime()) return;
                      // A server action revalida a rota sozinha: nada de
                      // recarregar na mão e mostrar estado velho no meio.
                      void aoSoltar(atual.id, novo.toISOString());
                    }}
                  >
                    {dele.map((c) => (
                      <div
                        key={c.id}
                        draggable
                        onDragStart={() => {
                          origem.current = { id: c.id, inicio: c.inicioPrevisto };
                          setArrastando(c.id);
                        }}
                        onDragEnd={() => {
                          setArrastando(null);
                        }}
                        title={`${c.paciente} · ${c.procedimento}`}
                        className={`mb-1 cursor-grab rounded-[6px] border px-1 py-0.5 text-[11px] ${
                          c.status === 'confirmado'
                            ? 'border-ok bg-ok/15'
                            : 'border-petrol border-dashed'
                        } ${arrastando === c.id ? 'opacity-50' : ''}`}
                      >
                        <span className="font-mono tabular-nums">
                          {hhmm(Date.parse(c.inicioPrevisto), fuso)}
                        </span>{' '}
                        {primeiroNome(c.paciente)}
                      </div>
                    ))}

                    {vagasDele.map((v) => (
                      <div
                        key={v.inicio}
                        className="livre relative mb-1 !static !h-auto !w-auto"
                        title={`Livre das ${hhmm(Date.parse(v.inicio), fuso)} às ${hhmm(Date.parse(v.fim), fuso)}`}
                      >
                        livre {hhmm(Date.parse(v.inicio), fuso)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
