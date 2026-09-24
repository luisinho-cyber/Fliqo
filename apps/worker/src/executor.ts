import {
  expedienteEmIntervalos,
  horariosLivres,
  noFuso,
  sugestoesVariadas,
  type Intervalo,
} from '@fliqo/core';
import {
  agenda,
  alertas,
  conversas,
  fila,
  pacientes,
  procedimentos,
  profissionais,
  type Trx,
} from '@fliqo/db';
import { validarChamada, type NomeFerramenta, type PerfilClinica } from '@fliqo/ai';
import type { ClienteWhatsApp } from '@fliqo/whatsapp';
import { abrirRodada } from './ofertas';

/**
 * O executor das ferramentas. A IA PEDE, o código DECIDE (CLAUDE.md, regra 4).
 *
 * Três coisas acontecem aqui e em nenhum outro lugar:
 *  1. clinic_id e patient_id são INJETADOS a partir da conversa. A IA nunca os vê
 *     e nunca os manda — nenhum texto de paciente consegue mexer na agenda de
 *     outra pessoa.
 *  2. Toda entrada passa por validarChamada antes de tocar no banco.
 *  3. Horário só é aceito se saiu de buscar_horarios nesta mesma execução. O
 *     modelo não inventa vaga, e não reaproveita uma vaga de ontem que já foi
 *     preenchida por outra pessoa.
 */

export interface ContextoDaConversa {
  clinicId: string;
  conversaId: string;
  pacienteId: string;
  perfil: PerfilClinica;
  fuso: string;
  agora: Date;
}

export type SaidaDaFerramenta = {
  /** JSON devolvido ao modelo. */
  conteudo: unknown;
  erro?: boolean;
  /** Efeitos que o job precisa saber depois do laço. */
  transferir?: { motivo: string; resumo: string };
};

/** Quantos dias para a frente a busca de horários olha. */
const JANELA_DIAS = 21;

function chave(procedimentoId: string, inicio: Date): string {
  return `${procedimentoId}|${inicio.toISOString()}`;
}

function hora(d: Date, fuso: string): string {
  return d.toLocaleString('pt-BR', {
    timeZone: fuso,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export class Executor {
  readonly #trx: Trx;
  readonly #ctx: ContextoDaConversa;
  /** Só para chamar a fila quando a assistente cancela uma consulta. */
  readonly #cliente: ClienteWhatsApp | undefined;
  /** Horário oferecido -> profissional que o tem livre. A trava da regra 4. */
  readonly #ofertados = new Map<string, string>();

  constructor(trx: Trx, ctx: ContextoDaConversa, cliente?: ClienteWhatsApp) {
    this.#trx = trx;
    this.#ctx = ctx;
    this.#cliente = cliente;
  }

  /** Só para o teste conferir o que foi realmente oferecido ao paciente. */
  get ofertados(): readonly string[] {
    return [...this.#ofertados.keys()];
  }

  async executar(nome: string, entrada: unknown): Promise<SaidaDaFerramenta> {
    const v = validarChamada(nome, entrada);
    if (!v.ok) return { conteudo: { erro: v.erro }, erro: true };

    const despacho: Record<NomeFerramenta, (e: never) => Promise<SaidaDaFerramenta>> = {
      buscar_horarios: (e) => this.#buscarHorarios(e),
      marcar_consulta: (e) => this.#marcarConsulta(e),
      minhas_consultas: () => this.#minhasConsultas(),
      remarcar_consulta: (e) => this.#remarcarConsulta(e),
      cancelar_consulta: (e) => this.#cancelarConsulta(e),
      entrar_lista_espera: (e) => this.#entrarListaEspera(e),
      transferir_para_humano: (e) => this.#transferir(e),
    };
    return despacho[v.nome](v.entrada as never);
  }

  async #buscarHorarios(e: {
    procedimento_id: string;
    a_partir_de: string;
    periodo: 'manha' | 'tarde' | 'noite' | 'qualquer';
  }): Promise<SaidaDaFerramenta> {
    const proc = await procedimentos.porId(this.#trx, e.procedimento_id);
    if (!proc || !proc.active) {
      return { conteudo: { erro: 'procedimento não encontrado' }, erro: true };
    }

    const equipe = await profissionais.listarAtivos(this.#trx);
    if (equipe.length === 0) {
      return { conteudo: { erro: 'a clínica não tem profissional ativo' }, erro: true };
    }

    const inicioDaBusca =
      e.a_partir_de < diaIso(this.#ctx.agora, this.#ctx.fuso)
        ? diaIso(this.#ctx.agora, this.#ctx.fuso)
        : e.a_partir_de;
    const expediente = expedienteEmIntervalos(
      this.#ctx.perfil.atendimento.expediente,
      inicioDaBusca,
      JANELA_DIAS,
      this.#ctx.fuso,
    );
    const fimDaJanela = expediente.at(-1)?.fim ?? this.#ctx.agora;

    const candidatos: { inicio: Date; profissionalId: string }[] = [];
    for (const p of equipe) {
      const ocupados: Intervalo[] = await agenda.ocupadosDoProfissional(
        this.#trx,
        p.id,
        this.#ctx.agora,
        fimDaJanela,
      );
      for (const inicio of horariosLivres({
        expediente: recortarPorPeriodo(expediente, e.periodo, this.#ctx.fuso),
        ocupados,
        duracaoMin: proc.duration_minutes,
        agora: this.#ctx.agora,
        antecedenciaMinimaMin: this.#ctx.perfil.atendimento.antecedenciaMinimaMin,
        limite: 40,
      })) {
        candidatos.push({ inicio, profissionalId: p.id });
      }
    }

    candidatos.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
    // Uma vaga por horário: dois profissionais livres às 14h são a mesma oferta
    // para o paciente, e quem atende é decisão da clínica, não dele.
    const porHorario = new Map<number, { inicio: Date; profissionalId: string }>();
    for (const c of candidatos) {
      if (!porHorario.has(c.inicio.getTime())) porHorario.set(c.inicio.getTime(), c);
    }
    const unicos = [...porHorario.values()];
    const escolhidos = sugestoesVariadas(
      unicos.map((c) => c.inicio),
      3,
    );

    const oferta = escolhidos.map((inicio) => {
      // O `find` acha sempre: `escolhidos` é um subconjunto de `unicos`.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const c = unicos.find((x) => x.inicio.getTime() === inicio.getTime())!;
      this.#ofertados.set(chave(proc.id, inicio), c.profissionalId);
      return { inicio: inicio.toISOString(), quando: hora(inicio, this.#ctx.fuso) };
    });

    if (oferta.length === 0) {
      return {
        conteudo: {
          horarios: [],
          aviso: 'nenhum horário livre nesse período; ofereça a lista de espera',
        },
      };
    }
    return { conteudo: { procedimento: proc.name, horarios: oferta } };
  }

  async #marcarConsulta(e: {
    procedimento_id: string;
    inicio: string;
  }): Promise<SaidaDaFerramenta> {
    const inicio = new Date(e.inicio);
    const profissionalId = this.#ofertados.get(chave(e.procedimento_id, inicio));
    if (profissionalId === undefined) {
      // A recusa é da regra 4, não um detalhe: horário que não saiu de
      // buscar_horarios pode estar fora do expediente, no passado ou já ocupado.
      return {
        conteudo: {
          erro: 'esse horário não veio de buscar_horarios nesta conversa. Chame buscar_horarios e ofereça um dos horários devolvidos.',
        },
        erro: true,
      };
    }

    const r = await agenda.criar(this.#trx, {
      profissionalId,
      pacienteId: this.#ctx.pacienteId,
      procedimentoId: e.procedimento_id,
      inicio,
      origem: 'ia',
    });
    if (!r.ok) {
      this.#ofertados.delete(chave(e.procedimento_id, inicio));
      return { conteudo: { erro: motivoParaOModelo(r.motivo) }, erro: true };
    }

    // Marcou pelo WhatsApp: é aqui que o consentimento para lembrete nasce.
    await pacientes.registrarConsentimento(this.#trx, this.#ctx.pacienteId, this.#ctx.agora);
    return {
      conteudo: {
        ok: true,
        consulta_id: r.consulta.id,
        quando: hora(r.consulta.starts_at, this.#ctx.fuso),
      },
    };
  }

  async #minhasConsultas(): Promise<SaidaDaFerramenta> {
    const lista = await agenda.proximasDoPaciente(this.#trx, this.#ctx.pacienteId, this.#ctx.agora);
    const nomes = new Map(
      (await procedimentos.listarAtivos(this.#trx)).map((p) => [p.id, p.name] as const),
    );
    return {
      conteudo: {
        consultas: lista.map((c) => ({
          consulta_id: c.id,
          procedimento: nomes.get(c.procedure_id) ?? 'procedimento',
          quando: hora(c.starts_at, this.#ctx.fuso),
          status: c.status,
        })),
      },
    };
  }

  async #remarcarConsulta(e: {
    consulta_id: string;
    novo_inicio: string;
  }): Promise<SaidaDaFerramenta> {
    const atual = await this.#minha(e.consulta_id);
    if (!atual) return { conteudo: { erro: 'consulta não encontrada' }, erro: true };

    const inicio = new Date(e.novo_inicio);
    if (!this.#ofertados.has(chave(atual.procedure_id, inicio))) {
      return {
        conteudo: {
          erro: 'esse horário não veio de buscar_horarios nesta conversa. Chame buscar_horarios para o procedimento desta consulta.',
        },
        erro: true,
      };
    }

    const r = await agenda.remarcar(this.#trx, e.consulta_id, inicio);
    if (!r.ok) {
      this.#ofertados.delete(chave(atual.procedure_id, inicio));
      return { conteudo: { erro: motivoParaOModelo(r.motivo) }, erro: true };
    }
    return {
      conteudo: {
        ok: true,
        consulta_id: r.consulta.id,
        quando: hora(r.consulta.starts_at, this.#ctx.fuso),
      },
    };
  }

  async #cancelarConsulta(e: { consulta_id: string; motivo: string }): Promise<SaidaDaFerramenta> {
    const atual = await this.#minha(e.consulta_id);
    if (!atual) return { conteudo: { erro: 'consulta não encontrada' }, erro: true };
    const c = await agenda.cancelar(this.#trx, e.consulta_id, e.motivo);
    if (!c) return { conteudo: { erro: 'não foi possível cancelar' }, erro: true };

    // Cancelou pela assistente é a mesma coisa que cancelou pelo botão: o
    // horário abriu e a fila precisa ser chamada. Sem isto, só o cancelamento
    // pela confirmação virava vaga oferecida.
    if (this.#cliente) {
      await abrirRodada(
        this.#trx,
        this.#cliente,
        this.#ctx.clinicId,
        {
          consultaId: c.id,
          profissionalId: c.professional_id,
          inicio: c.starts_at,
          fim: c.ends_at,
        },
        this.#ctx.agora,
      );
    }
    return { conteudo: { ok: true } };
  }

  async #entrarListaEspera(e: {
    procedimento_id: string;
    de: string;
    ate: string;
  }): Promise<SaidaDaFerramenta> {
    const proc = await procedimentos.porId(this.#trx, e.procedimento_id);
    if (!proc) return { conteudo: { erro: 'procedimento não encontrado' }, erro: true };

    const entrada = await fila.entrar(this.#trx, this.#ctx.clinicId, {
      pacienteId: this.#ctx.pacienteId,
      procedimentoId: e.procedimento_id,
      janelaInicio: noComecoDoDia(e.de, this.#ctx.fuso),
      janelaFim: noFimDoDia(e.ate, this.#ctx.fuso),
    });
    return { conteudo: { ok: true, espera_id: entrada.id } };
  }

  async #transferir(e: { motivo: string; resumo: string }): Promise<SaidaDaFerramenta> {
    await conversas.definirModo(this.#trx, this.#ctx.conversaId, 'humano', e.motivo);
    await alertas.criar(this.#trx, this.#ctx.clinicId, {
      tipo: 'conversa_assumida',
      gravidade: e.motivo === 'urgencia' ? 'urgente' : 'atencao',
      titulo: 'A assistente passou uma conversa para a equipe',
      // O resumo é da IA, não é conteúdo cru do paciente (CLAUDE.md, estilo de código).
      corpo: `${e.motivo}: ${e.resumo}`,
      conversaId: this.#ctx.conversaId,
      pacienteId: this.#ctx.pacienteId,
    });
    return {
      conteudo: { ok: true },
      transferir: { motivo: e.motivo, resumo: e.resumo },
    };
  }

  /** Consulta do paciente DESTA conversa. Id de outro paciente vira "não encontrada". */
  async #minha(consultaId: string) {
    const c = await agenda.porId(this.#trx, consultaId);
    return c && c.patient_id === this.#ctx.pacienteId ? c : undefined;
  }
}

function motivoParaOModelo(motivo: string): string {
  return motivo === 'horario_ocupado'
    ? 'esse horário acabou de ser ocupado; busque horários de novo e ofereça outro'
    : motivo;
}

function diaIso(d: Date, fuso: string): string {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso }).format(d);
}

function noComecoDoDia(dataIso: string, fuso: string): Date {
  return noFuso(dataIso, '00:00', fuso);
}

function noFimDoDia(dataIso: string, fuso: string): Date {
  return noFuso(dataIso, '23:59', fuso);
}

function recortarPorPeriodo(
  expediente: Intervalo[],
  periodo: 'manha' | 'tarde' | 'noite' | 'qualquer',
  fuso: string,
): Intervalo[] {
  if (periodo === 'qualquer') return expediente;
  const faixa = { manha: [0, 12], tarde: [12, 18], noite: [18, 24] }[periodo] as [number, number];
  return expediente
    .map((bloco) => {
      const dia = diaIso(bloco.inicio, fuso);
      const de = noFuso(dia, `${String(faixa[0]).padStart(2, '0')}:00`, fuso);
      const ate =
        faixa[1] === 24
          ? noFuso(dia, '23:59', fuso)
          : noFuso(dia, `${String(faixa[1]).padStart(2, '0')}:00`, fuso);
      const inicio = bloco.inicio > de ? bloco.inicio : de;
      const fim = bloco.fim < ate ? bloco.fim : ate;
      return { inicio, fim };
    })
    .filter((b) => b.inicio < b.fim);
}
