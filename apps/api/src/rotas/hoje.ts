import {
  diaNoFuso,
  semanaNoFuso,
  duracaoParaProjecao,
  mancheteDoDia,
  projetarDia,
  vagasEntreAtendimentos,
  type ConsultaDoDia,
  type Intervalo,
} from '@fliqo/core';
import { alertas, atrasos, hoje, profissionais, withClinic, type Trx } from '@fliqo/db';
import type { FastifyInstance } from 'fastify';
import { autenticar } from '../auth';
import { comUsuario, UUID, type ContextoPainel } from './contexto';

/**
 * A tela Hoje, montada de uma vez.
 *
 * O dia inteiro numa resposta porque a tela é uma só: a Linha do Dia, a manchete
 * e a lista de decisões são leituras do MESMO instante. Buscar em três chamadas
 * deixaria a faixa mostrando um atraso que a manchete ainda não conhece.
 *
 * A projeção do atraso é feita aqui, no servidor, e não no navegador: é regra de
 * negócio (packages/core), e o relógio que vale é o do servidor — um computador
 * com a hora errada na recepção não pode deslocar o dia de todo mundo.
 */

export interface ClinicaDaPessoa {
  id: string;
  nome: string;
}

export interface ConsultaDaTela {
  id: string;
  profissionalId: string;
  pacienteId: string;
  paciente: string;
  procedimento: string;
  inicioAgendado: string;
  fimAgendado: string;
  inicioPrevisto: string;
  duracaoEsperadaMin: number;
  atrasoMin: number;
  situacao: 'finalizada' | 'em_atendimento' | 'aguardando';
  status: string;
  precoCents: number;
  chegou: boolean;
}

export interface ProfissionalDaTela {
  id: string;
  nome: string;
  atrasoMin: number;
}

export interface VagaDaTela {
  profissionalId: string;
  inicio: string;
  fim: string;
}

export interface DecisaoDaTela {
  id: string;
  tipo: string;
  gravidade: 'info' | 'atencao' | 'urgente';
  titulo: string;
  detalhe: string | null;
  consultaId: string | null;
}

export interface RespostaHoje {
  clinica: ClinicaDaPessoa;
  fuso: string;
  dataIso: string;
  agora: string;
  manchete: { quantidade: number; naAgendaCents: number; semConfirmacaoCents: number };
  profissionais: ProfissionalDaTela[];
  consultas: ConsultaDaTela[];
  vagas: VagaDaTela[];
  decisoes: DecisaoDaTela[];
}

/** Buraco menor que isto não é vaga: ninguém sai de casa e chega em quinze minutos. */
const VAGA_MINIMA_MIN = 20;

export interface DiaDaSemanaApi {
  dataIso: string;
  ehHoje: boolean;
  consultas: ConsultaDaTela[];
  vagas: VagaDaTela[];
}

export interface RespostaSemana {
  clinica: ClinicaDaPessoa;
  fuso: string;
  agora: string;
  profissionais: ProfissionalDaTela[];
  dias: DiaDaSemanaApi[];
}

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export function registrarHoje(app: FastifyInstance, ctx: ContextoPainel): void {
  /**
   * A semana por profissional.
   *
   * O atraso só é calculado na coluna de HOJE. Atraso é o efeito cascata do dia
   * que está acontecendo: projetar atraso para quinta-feira seria inventar um
   * número que nada sustenta, e a recepção remarcaria em cima dele.
   */
  app.get('/api/agenda/semana', async (req, reply) => {
    const { de, profissionalId } = req.query as { de?: string; profissionalId?: string };
    if (de !== undefined && !DATA_ISO.test(de)) {
      return reply.code(400).send({ erro: 'data_invalida' });
    }
    if (profissionalId !== undefined && !UUID.test(profissionalId)) {
      return reply.code(400).send({ erro: 'pedido_invalido' });
    }

    const agora = new Date();
    const r = await comUsuario(ctx, req, reply, (trx, u) =>
      montarSemana(trx, u.clinicId, agora, de, profissionalId),
    );
    return r.respondido ? reply : reply.send(r.valor);
  });

  /**
   * As clínicas da pessoa. É a única rota do painel sem `x-clinica` — a pergunta
   * vem ANTES de haver clínica, e por isso passa pela função `security definer`
   * que devolve só ids. O nome vem depois, já dentro da RLS de cada uma.
   */
  app.get('/api/minhas-clinicas', async (req, reply) => {
    const auth = await autenticar(req.headers.authorization, ctx.segredoJwt);
    if (!auth.ok) return reply.code(401).send({ erro: auth.motivo });

    const ids = await hoje.clinicasDoUsuario(ctx.db, auth.userId);
    const lista: ClinicaDaPessoa[] = [];
    for (const id of ids) {
      const c = await withClinic(id, (trx) => hoje.dadosDaClinica(trx, id), ctx.db);
      lista.push({ id: c.id, nome: c.nome });
    }
    return reply.send(lista);
  });

  app.get('/api/hoje', async (req, reply) => {
    const agora = new Date();
    const r = await comUsuario(ctx, req, reply, (trx, u) => montar(trx, u.clinicId, agora));
    return r.respondido ? reply : reply.send(r.valor);
  });
}

async function montar(trx: Trx, clinicId: string, agora: Date): Promise<RespostaHoje> {
  const clinica = await hoje.dadosDaClinica(trx, clinicId);
  const { dataIso, inicio, fim } = diaNoFuso(agora, clinica.fuso);

  const doDia = await hoje.agendaDoDia(trx, inicio, fim);
  const equipe = await profissionais.listarAtivos(trx);
  const medidas = await atrasos.duracoesMedidas(trx);
  const porChave = new Map(
    medidas.map((m) => [`${m.professional_id}|${m.procedure_id}`, m] as const),
  );
  const abertos = await alertas.abertos(trx);

  const consultas: ConsultaDaTela[] = [];
  const vagas: VagaDaTela[] = [];
  const atrasoPorProfissional = new Map<string, number>();

  // Um profissional de cada vez: o efeito cascata é dentro da agenda de UMA
  // pessoa. Somar as duas agendas deslocaria o dia de quem está no horário.
  for (const prof of equipe) {
    const dele = doDia.filter((c) => c.professional_id === prof.id);
    if (dele.length === 0) continue;

    const paraCore: ConsultaDoDia[] = dele.map((c) => ({
      id: c.id,
      inicioAgendado: c.starts_at,
      fimAgendado: c.ends_at,
      duracaoEsperadaMin: duracaoParaProjecao(
        porChave.get(`${c.professional_id}|${c.procedure_id}`),
        c.duracao_agenda_min,
      ),
      status: c.status,
      ...(c.checked_in_at === null ? {} : { pacienteChegouEm: c.checked_in_at }),
      ...(c.started_at === null ? {} : { iniciadaEm: c.started_at }),
      ...(c.finished_at === null ? {} : { finalizadaEm: c.finished_at }),
    }));
    const previsao = projetarDia(paraCore, agora);
    const porId = new Map(previsao.map((p) => [p.id, p]));
    const duracaoPorId = new Map(paraCore.map((c) => [c.id, c.duracaoEsperadaMin]));

    let atrasoDoProf = 0;
    const ocupados: Intervalo[] = [];

    for (const c of dele) {
      const p = porId.get(c.id);
      const duracao = duracaoPorId.get(c.id) ?? c.duracao_agenda_min;
      const inicioPrevisto = p?.inicioPrevisto ?? c.starts_at;
      if (p && p.situacao !== 'finalizada') atrasoDoProf = Math.max(atrasoDoProf, p.atrasoMin);
      if (p) {
        ocupados.push({
          inicio: inicioPrevisto,
          fim: new Date(inicioPrevisto.getTime() + duracao * 60_000),
        });
      }

      consultas.push({
        id: c.id,
        profissionalId: c.professional_id,
        pacienteId: c.patient_id,
        paciente: c.paciente,
        procedimento: c.procedimento,
        inicioAgendado: c.starts_at.toISOString(),
        fimAgendado: c.ends_at.toISOString(),
        inicioPrevisto: inicioPrevisto.toISOString(),
        duracaoEsperadaMin: duracao,
        atrasoMin: p?.atrasoMin ?? 0,
        situacao: p?.situacao ?? 'aguardando',
        status: c.status,
        precoCents: c.price_cents,
        chegou: c.checked_in_at !== null,
      });
    }

    atrasoPorProfissional.set(prof.id, atrasoDoProf);
    for (const v of vagasEntreAtendimentos(ocupados, VAGA_MINIMA_MIN)) {
      vagas.push({
        profissionalId: prof.id,
        inicio: v.inicio.toISOString(),
        fim: v.fim.toISOString(),
      });
    }
  }

  return {
    clinica: { id: clinica.id, nome: clinica.nome },
    fuso: clinica.fuso,
    dataIso,
    agora: agora.toISOString(),
    manchete: mancheteDoDia(doDia.map((c) => ({ status: c.status, precoCents: c.price_cents }))),
    profissionais: equipe
      .filter((p) => atrasoPorProfissional.has(p.id))
      .map((p) => ({ id: p.id, nome: p.name, atrasoMin: atrasoPorProfissional.get(p.id) ?? 0 })),
    consultas: consultas.sort((a, b) => a.inicioPrevisto.localeCompare(b.inicioPrevisto)),
    vagas,
    decisoes: abertos.map((a) => ({
      id: a.id,
      tipo: a.kind,
      gravidade: a.severity,
      titulo: a.title,
      detalhe: a.body,
      consultaId: a.appointment_id,
    })),
  };
}

async function montarSemana(
  trx: Trx,
  clinicId: string,
  agora: Date,
  de: string | undefined,
  profissionalId: string | undefined,
): Promise<RespostaSemana> {
  const clinica = await hoje.dadosDaClinica(trx, clinicId);
  const hojeDaClinica = diaNoFuso(agora, clinica.fuso);
  const semana = semanaNoFuso(de ?? hojeDaClinica.dataIso, clinica.fuso);

  const daSemana = await hoje.agendaDoDia(trx, semana.inicio, semana.fim);
  const equipe = (await profissionais.listarAtivos(trx)).filter(
    (p) => profissionalId === undefined || p.id === profissionalId,
  );
  const medidas = await atrasos.duracoesMedidas(trx);
  const porChave = new Map(
    medidas.map((m) => [`${m.professional_id}|${m.procedure_id}`, m] as const),
  );

  const atrasoPorProfissional = new Map<string, number>();
  const dias: DiaDaSemanaApi[] = [];

  for (const dia of semana.dias) {
    const ehHoje = dia.dataIso === hojeDaClinica.dataIso;
    const doDia = daSemana.filter((c) => c.starts_at >= dia.inicio && c.starts_at < dia.fim);

    const consultas: ConsultaDaTela[] = [];
    const vagas: VagaDaTela[] = [];

    for (const prof of equipe) {
      const dele = doDia.filter((c) => c.professional_id === prof.id);
      if (dele.length === 0) continue;

      const paraCore: ConsultaDoDia[] = dele.map((c) => ({
        id: c.id,
        inicioAgendado: c.starts_at,
        fimAgendado: c.ends_at,
        duracaoEsperadaMin: duracaoParaProjecao(
          porChave.get(`${c.professional_id}|${c.procedure_id}`),
          c.duracao_agenda_min,
        ),
        status: c.status,
        ...(c.checked_in_at === null ? {} : { pacienteChegouEm: c.checked_in_at }),
        ...(c.started_at === null ? {} : { iniciadaEm: c.started_at }),
        ...(c.finished_at === null ? {} : { finalizadaEm: c.finished_at }),
      }));

      // Só hoje tem projeção de atraso. Nos outros dias o bloco fica onde foi
      // marcado, que é a verdade que existe sobre eles.
      const previsao = ehHoje ? projetarDia(paraCore, agora) : [];
      const porId = new Map(previsao.map((p) => [p.id, p]));
      const duracaoPorId = new Map(paraCore.map((c) => [c.id, c.duracaoEsperadaMin]));
      const ocupados: Intervalo[] = [];

      for (const c of dele) {
        const p = porId.get(c.id);
        const duracao = duracaoPorId.get(c.id) ?? c.duracao_agenda_min;
        const inicioPrevisto = p?.inicioPrevisto ?? c.starts_at;
        if (ehHoje && p && p.situacao !== 'finalizada') {
          atrasoPorProfissional.set(
            prof.id,
            Math.max(atrasoPorProfissional.get(prof.id) ?? 0, p.atrasoMin),
          );
        }
        if (c.status !== 'cancelado' && c.status !== 'faltou') {
          ocupados.push({
            inicio: inicioPrevisto,
            fim: new Date(inicioPrevisto.getTime() + duracao * 60_000),
          });
        }

        consultas.push({
          id: c.id,
          profissionalId: c.professional_id,
          pacienteId: c.patient_id,
          paciente: c.paciente,
          procedimento: c.procedimento,
          inicioAgendado: c.starts_at.toISOString(),
          fimAgendado: c.ends_at.toISOString(),
          inicioPrevisto: inicioPrevisto.toISOString(),
          duracaoEsperadaMin: duracao,
          atrasoMin: p?.atrasoMin ?? 0,
          situacao: p?.situacao ?? 'aguardando',
          status: c.status,
          precoCents: c.price_cents,
          chegou: c.checked_in_at !== null,
        });
      }

      for (const v of vagasEntreAtendimentos(ocupados, VAGA_MINIMA_MIN)) {
        vagas.push({
          profissionalId: prof.id,
          inicio: v.inicio.toISOString(),
          fim: v.fim.toISOString(),
        });
      }
    }

    dias.push({ dataIso: dia.dataIso, ehHoje, consultas, vagas });
  }

  return {
    clinica: { id: clinica.id, nome: clinica.nome },
    fuso: clinica.fuso,
    agora: agora.toISOString(),
    profissionais: equipe.map((p) => ({
      id: p.id,
      nome: p.name,
      atrasoMin: atrasoPorProfissional.get(p.id) ?? 0,
    })),
    dias,
  };
}
