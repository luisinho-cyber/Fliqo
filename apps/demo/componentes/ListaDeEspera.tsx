'use client';

import { PROCEDIMENTOS, type EsperaDemo } from '../nucleo/dados';
import type { Oferta } from '../nucleo/estado';
import { hhmm } from '../nucleo/relogio';
import { Ilustracao } from './Ilustracao';

/**
 * A lista de espera só vira consulta quando uma vaga abre. Quando abre, a oferta
 * vai para as primeiras da fila AO MESMO TEMPO (lote de três, pela configuração
 * da clínica) e quem responde primeiro fica com ela — quem decide isso é o banco,
 * não a ordem em que a mensagem chegou.
 *
 * Quem não ficou com a vaga não sai da fila: continua na posição em que estava.
 */

const ROTULO: Record<EsperaDemo['estado'], { texto: string; classe: string }> = {
  aguardando: { texto: 'na fila', classe: 'neutro' },
  ofertado: { texto: 'oferta enviada', classe: 'agora' },
  ficou_com_a_vaga: { texto: 'ficou com a vaga', classe: 'ok' },
  segue_na_fila: { texto: 'segue na fila', classe: 'neutro' },
};

export function ListaDeEspera({ fila, oferta }: { fila: EsperaDemo[]; oferta: Oferta | null }) {
  return (
    <div data-testid="lista-de-espera">
      <div className="secao-cab">
        <h2>Lista de espera</h2>
        <Ilustracao>a oferta aparece aqui, mas nenhuma mensagem é enviada</Ilustracao>
      </div>

      <p className="apoio" data-testid="estado-da-oferta">
        {oferta === null
          ? 'Nenhuma vaga aberta agora. Quando um horário for liberado, a oferta sai para as três primeiras da fila.'
          : `Oferta aberta para ${String(oferta.quantos)} pacientes, válida até ${hhmm(oferta.expiraEm)}. Quem responder primeiro fica com o horário.`}
      </p>

      {fila.length === 0 ? (
        <p className="vazio">
          Ninguém na fila. Quando um paciente pedir um horário que já está cheio, ele entra aqui.
        </p>
      ) : (
        <div className="tabela-rolagem">
          <table className="tabela">
            <caption className="sr">Pacientes na lista de espera</caption>
            <thead>
              <tr>
                <th scope="col">Paciente</th>
                <th scope="col">Procedimento</th>
                <th scope="col">Na fila</th>
                <th scope="col">Situação</th>
              </tr>
            </thead>
            <tbody>
              {fila.map((w) => {
                const marca = ROTULO[w.estado];
                return (
                  <tr key={w.id} data-testid={`espera-${w.id}`}>
                    <td>{w.paciente}</td>
                    <td>{PROCEDIMENTOS[w.procedimentoId]?.nome ?? '—'}</td>
                    <td className="apoio-celula">{w.desde}</td>
                    <td>
                      <span className={`estado ${marca.classe}`}>{marca.texto}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
