'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarraApresentador } from '../componentes/BarraApresentador';
import { Caixa } from '../componentes/Caixa';
import { CanalDoPaciente } from '../componentes/CanalDoPaciente';
import { Conversas } from '../componentes/Conversas';
import { Decisoes } from '../componentes/Decisoes';
import { LinhaDoDia } from '../componentes/LinhaDoDia';
import { ListaDeEspera } from '../componentes/ListaDeEspera';
import { Manchete } from '../componentes/Manchete';
import { Pontualidade } from '../componentes/Pontualidade';
import { agora, brl } from '../nucleo/calculos';
import { CLINICA } from '../nucleo/dados';
import { estadoInicial, semDecisao, type Aba, type ApiDeCena, type Estado } from '../nucleo/estado';
import { CENAS } from '../nucleo/roteiro';

const ABAS: { chave: Aba; rotulo: string }[] = [
  { chave: 'dia', rotulo: 'Linha do dia' },
  { chave: 'conversas', rotulo: 'Conversas' },
  { chave: 'fila', rotulo: 'Lista de espera' },
  { chave: 'caixa', rotulo: 'Caixa' },
  { chave: 'pontualidade', rotulo: 'Pontualidade' },
];

export default function Pagina() {
  const [estado, setEstado] = useState<Estado>(estadoInicial);
  // O dia de hoje só existe no navegador: a página é estática e seria gerada
  // com a data da publicação. Montar primeiro evita mostrar um dia errado.
  const [montado, setMontado] = useState(false);
  useEffect(() => {
    setMontado(true);
  }, []);

  const cenaRef = useRef(0);
  const avisoRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const api: ApiDeCena = useMemo(
    () => ({
      ajustar: (f) => {
        setEstado(f);
      },
      esperar: (ms) =>
        new Promise<void>((resolver) => {
          setTimeout(resolver, ms);
        }),
      avisar: (texto) => {
        setEstado((e) => ({ ...e, aviso: texto }));
        if (avisoRef.current !== null) clearTimeout(avisoRef.current);
        avisoRef.current = setTimeout(() => {
          setEstado((e) => ({ ...e, aviso: null }));
        }, 4200);
      },
    }),
    [],
  );

  const avancar = useCallback(() => {
    const i = cenaRef.current;
    const cena = CENAS[i];
    if (!cena) return;
    cenaRef.current = i + 1;
    setEstado((e) => ({ ...e, cena: i + 1, aviso: null }));
    void cena.executar(api);
  }, [api]);

  const recomecar = useCallback(() => {
    cenaRef.current = 0;
    if (avisoRef.current !== null) clearTimeout(avisoRef.current);
    setEstado(estadoInicial());
  }, []);

  const irPara = useCallback(
    (i: number) => {
      const cena = CENAS[i];
      if (!cena) return;
      cenaRef.current = i + 1;
      setEstado({ ...estadoInicial(), cena: i + 1 });
      void cena.executar(api);
    },
    [api],
  );

  useEffect(() => {
    function aoTeclar(ev: KeyboardEvent) {
      const alvo = ev.target;
      if (alvo instanceof HTMLInputElement || alvo instanceof HTMLTextAreaElement) return;
      if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        avancar();
      } else if (ev.key === 'r' || ev.key === 'R') {
        recomecar();
      } else if (ev.key === 'h' || ev.key === 'H') {
        setEstado((e) => ({ ...e, apresentadorEscondido: !e.apresentadorEscondido }));
      }
    }
    window.addEventListener('keydown', aoTeclar);
    return () => {
      window.removeEventListener('keydown', aoTeclar);
    };
  }, [avancar, recomecar]);

  useEffect(
    () => () => {
      if (avisoRef.current !== null) clearTimeout(avisoRef.current);
    },
    [],
  );

  const conversa = estado.conversas[estado.conversaAtiva];

  return (
    <div className="app">
      <header className="topo">
        <span className="marca">
          Fliqo<i>.</i>
        </span>
        <nav className="abas" aria-label="Telas">
          {ABAS.map((a) => (
            <button
              key={a.chave}
              className="aba"
              aria-current={estado.aba === a.chave ? 'true' : 'false'}
              data-testid={`aba-${a.chave}`}
              onClick={() => {
                setEstado((e) => ({ ...e, aba: a.chave }));
              }}
            >
              {a.rotulo}
            </button>
          ))}
        </nav>
        <span style={{ marginLeft: 'auto', color: 'var(--ink-suave)', fontSize: 13 }}>
          {CLINICA.nome}
        </span>
      </header>

      <main className="corpo">
        <section className="painel">
          {!montado ? (
            <p style={{ color: 'var(--ink-suave)' }}>Carregando o dia da clínica…</p>
          ) : estado.aba === 'dia' ? (
            <>
              <Manchete consultas={estado.consultas} dia={estado.dia} />

              <div className="abas" style={{ marginBottom: 'var(--e-3)' }}>
                <button
                  className="aba"
                  aria-current={estado.dia === 'hoje' ? 'true' : 'false'}
                  data-testid="dia-hoje"
                  onClick={() => {
                    setEstado((e) => ({ ...e, dia: 'hoje' }));
                  }}
                >
                  Hoje
                </button>
                <button
                  className="aba"
                  aria-current={estado.dia === 'amanha' ? 'true' : 'false'}
                  data-testid="dia-amanha"
                  onClick={() => {
                    setEstado((e) => ({ ...e, dia: 'amanha' }));
                  }}
                >
                  Amanhã
                </button>
              </div>

              <LinhaDoDia
                consultas={estado.consultas}
                dia={estado.dia}
                agora={agora()}
                selecionada={estado.selecionada}
                aoSelecionar={(id) => {
                  setEstado((e) => ({ ...e, selecionada: id }));
                }}
              />

              {estado.recuperadoCentavos > 0 && (
                <p data-testid="recuperado" style={{ fontSize: 14 }}>
                  Recuperado nesta apresentação:{' '}
                  <b className="mono" style={{ color: 'var(--ok)' }}>
                    {brl(estado.recuperadoCentavos)}
                  </b>
                </p>
              )}
            </>
          ) : estado.aba === 'conversas' ? (
            <Conversas
              conversas={estado.conversas}
              ativa={estado.conversaAtiva}
              aoAbrir={(chave) => {
                setEstado((e) => ({ ...e, conversaAtiva: chave }));
              }}
            />
          ) : estado.aba === 'fila' ? (
            <ListaDeEspera fila={estado.fila} />
          ) : estado.aba === 'caixa' ? (
            <Caixa consultas={estado.consultas} />
          ) : (
            <Pontualidade consultas={estado.consultas} />
          )}
        </section>

        <aside style={{ display: 'grid', gap: 'var(--e-4)', minWidth: 0 }}>
          <div className="painel">
            <h3 style={{ marginBottom: 'var(--e-2)' }}>Precisa de decisão</h3>
            <Decisoes
              decisoes={estado.decisoes}
              aoResolver={(id) => {
                setEstado((e) => semDecisao(e, id));
              }}
            />
          </div>
          {conversa && <CanalDoPaciente conversa={conversa} api={api} />}
        </aside>
      </main>

      <footer className="rodape">Ambiente de demonstração · dados fictícios</footer>

      {estado.aviso !== null && (
        <div className="aviso-tela" role="status" data-testid="aviso">
          {estado.aviso}
        </div>
      )}

      <BarraApresentador
        cenas={CENAS}
        atual={estado.cena}
        escondida={estado.apresentadorEscondido}
        aoAvancar={avancar}
        aoRecomecar={recomecar}
        aoIrPara={irPara}
      />
    </div>
  );
}
