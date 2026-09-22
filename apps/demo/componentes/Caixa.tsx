'use client';

import { useEffect, useState } from 'react';
import {
  brl,
  contaDaCalculadora,
  faltasDoMes,
  lerCalculadoraDaUrl,
  marcadoEEsperado,
  CALCULADORA_PADRAO,
  type EntradaCalculadora,
} from '../nucleo/calculos';
import type { ConsultaDemo } from '../nucleo/dados';

const LARGURA = 640;
const ALTURA = 220;
const MARGEM = 28;

function caminho(valores: number[], teto: number): string {
  if (valores.length < 2) return '';
  const passo = (LARGURA - MARGEM * 2) / (valores.length - 1);
  return valores
    .map((v, i) => {
      const x = MARGEM + i * passo;
      const y = ALTURA - MARGEM - (teto === 0 ? 0 : (v / teto) * (ALTURA - MARGEM * 2));
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function diaDoMes(iso: string): string {
  const [, mes, dia] = iso.split('-');
  return `${dia ?? ''}/${mes ?? ''}`;
}

/**
 * Caixa: a terceira assinatura do DESIGN.md. Duas linhas — o que está marcado
 * (tracejado) e o que a clínica pode mesmo esperar (cheio). A distância entre
 * elas é a conversa de venda inteira.
 */
export function Caixa({ consultas }: { consultas: ConsultaDemo[] }) {
  const [entrada, setEntrada] = useState<EntradaCalculadora>(CALCULADORA_PADRAO);

  // Os números vêm da URL para o vendedor abrir a tela já com os da clínica.
  // Lido depois da montagem: a página é estática e não conhece a query no servidor.
  useEffect(() => {
    setEntrada(lerCalculadoraDaUrl(window.location.search));
  }, []);

  const serie = marcadoEEsperado(consultas, 45);
  const teto = serie.reduce((m, p) => Math.max(m, p.marcado), 0);
  const ultimo = serie[serie.length - 1];
  const faltas = faltasDoMes();
  const conta = contaDaCalculadora(entrada);
  const diferenca = ultimo ? ultimo.marcado - ultimo.esperado : 0;

  return (
    <div data-testid="caixa">
      <h2>Caixa dos próximos 45 dias</h2>
      <p style={{ color: 'var(--ink-suave)', fontSize: 14, marginTop: 4 }}>
        A linha tracejada é o que está marcado. A cheia é o que costuma entrar de verdade, com a
        chance de cada consulta acontecer.
      </p>

      <svg
        className="grafico"
        viewBox={`0 0 ${String(LARGURA)} ${String(ALTURA)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Caixa marcado e caixa esperado nos próximos 45 dias"
        data-testid="grafico-caixa"
      >
        <line
          x1={MARGEM}
          y1={ALTURA - MARGEM}
          x2={LARGURA - MARGEM}
          y2={ALTURA - MARGEM}
          stroke="var(--linha)"
        />
        <path
          d={caminho(
            serie.map((p) => p.marcado),
            teto,
          )}
          fill="none"
          stroke="var(--ink-suave)"
          strokeWidth={2}
          strokeDasharray="6 5"
        />
        <path
          d={caminho(
            serie.map((p) => p.esperado),
            teto,
          )}
          fill="none"
          stroke="var(--petrol)"
          strokeWidth={2.5}
        />
      </svg>

      <div className="legenda">
        <span>
          <i className="trac" />
          marcado {ultimo ? brl(ultimo.marcado) : '—'}
        </span>
        <span>
          <i />
          esperado {ultimo ? brl(ultimo.esperado) : '—'}
        </span>
        <span>
          diferença <b className="mono">{brl(diferenca)}</b> até{' '}
          {ultimo ? diaDoMes(ultimo.data) : '—'}
        </span>
      </div>

      <h3 style={{ marginTop: 'var(--e-5)' }}>Faltas deste mês</h3>
      <div className="figs" style={{ marginTop: 'var(--e-2)' }}>
        <div className="fig">
          <b>{faltas.quantidade}</b>
          <span>pacientes não vieram</span>
        </div>
        <div className="fig">
          <b className="risco" style={{ color: 'var(--risk)' }}>
            {brl(faltas.valor)}
          </b>
          <span>que a clínica deixou de faturar</span>
        </div>
      </div>

      <h3 style={{ marginTop: 'var(--e-5)' }}>Quanto isso custa na sua clínica</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 'var(--e-3)',
          marginTop: 'var(--e-2)',
        }}
      >
        <label className="campo">
          <span>Consultas por mês</span>
          <input
            type="number"
            min={1}
            value={entrada.consultasPorMes}
            data-testid="calc-consultas"
            onChange={(ev) => {
              setEntrada({ ...entrada, consultasPorMes: Number(ev.target.value) || 0 });
            }}
          />
        </label>
        <label className="campo">
          <span>Faltas (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            value={entrada.faltaPct}
            data-testid="calc-falta"
            onChange={(ev) => {
              setEntrada({ ...entrada, faltaPct: Number(ev.target.value) || 0 });
            }}
          />
        </label>
        <label className="campo">
          <span>Ticket médio (R$)</span>
          <input
            type="number"
            min={1}
            value={Math.round(entrada.ticketCentavos / 100)}
            data-testid="calc-ticket"
            onChange={(ev) => {
              setEntrada({
                ...entrada,
                ticketCentavos: Math.round((Number(ev.target.value) || 0) * 100),
              });
            }}
          />
        </label>
      </div>

      <table style={{ marginTop: 'var(--e-2)' }} data-testid="tabela-calculadora">
        <tbody>
          <tr>
            <td>Faltas por mês</td>
            <td className="num">{conta.faltasPorMes}</td>
          </tr>
          <tr>
            <td>Perdido por mês</td>
            <td className="num" style={{ color: 'var(--risk)' }}>
              {brl(conta.perdaMes)}
            </td>
          </tr>
          <tr>
            <td>Perdido por ano</td>
            <td className="num" style={{ color: 'var(--risk)' }} data-testid="perda-ano">
              {brl(conta.perdaAno)}
            </td>
          </tr>
          <tr>
            <td>Recuperado com confirmação e lista de espera</td>
            <td className="num" style={{ color: 'var(--ok)' }} data-testid="recuperado-ano">
              {brl(conta.recuperadoAno)}
            </td>
          </tr>
        </tbody>
      </table>
      <p style={{ color: 'var(--ink-suave)', fontSize: 13 }}>
        A recuperação usa 60% das faltas — o piso do que vemos com confirmação de véspera e fila
        acionada na hora.
      </p>
    </div>
  );
}
