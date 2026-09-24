import {
  CONFIG_ATRASOS_PADRAO,
  decidirAvisos,
  duracaoParaProjecao,
  esperandoDemais,
  noFuso,
  projetarDia,
  respeitarLimiteDeAvisos,
  somarDias,
  type ConsultaDoDia,
} from '@fliqo/core';
import { alertas, atrasos, numeros, pacientes, withClinic, type Db, type Trx } from '@fliqo/db';
import { TEMPLATES, type ClienteWhatsApp } from '@fliqo/whatsapp';
import { enviarAtivo } from './envio';

/**
 * Atraso do profissional, avisado antes de o paciente sair de casa.
 *
 * O atraso raramente é culpa de alguém: é a duração subestimada na agenda se
 * acumulando. O que o sistema faz é contar a verdade a tempo — espera explicada
 * incomoda muito menos do que espera sem explicação.
 *
 * Quem decide QUEM avisar é packages/core (`decidirAvisos`). Aqui só se executa,
 * e se guarda o que foi enviado: é o registro em `delay_notices` que amarra o
 * aviso de atraso ao aviso de "voltou ao normal" — quem foi avisado de que podia
 * chegar mais tarde precisa saber quando o horário original volta a valer.
 */

export interface DependenciasDeAtrasos {
  db: Db;
  whatsapp: ClienteWhatsApp;
  agora?: () => Date;
  /** Teto de avisos por consulta. Três já são muitas; a quarta vira incômodo. */
  maxAvisos?: number;
}

export interface ResultadoDaVarredura {
  clinicas: number;
  avisosAoPaciente: number;
  alertasDeRecepcao: number;
  alertasDeEspera: number;
}

const MAX_AVISOS_PADRAO = 3;

/** Uma volta completa: todas as clínicas com atendimento hoje. */
export async function varrerAtrasos(dep: DependenciasDeAtrasos): Promise<ResultadoDaVarredura> {
  const clinicas = await atrasos.clinicasParaVarrer(dep.db);
  const total: ResultadoDaVarredura = {
    clinicas: clinicas.length,
    avisosAoPaciente: 0,
    alertasDeRecepcao: 0,
    alertasDeEspera: 0,
  };

  for (const clinicId of clinicas) {
    const r = await varrerClinica(dep, clinicId);
    total.avisosAoPaciente += r.avisosAoPaciente;
    total.alertasDeRecepcao += r.alertasDeRecepcao;
    total.alertasDeEspera += r.alertasDeEspera;
  }
  return total;
}

export type ResultadoDaClinica = Omit<ResultadoDaVarredura, 'clinicas'>;

export async function varrerClinica(
  dep: DependenciasDeAtrasos,
  clinicId: string,
): Promise<ResultadoDaClinica> {
  const agora = (dep.agora ?? (() => new Date()))();
  return withClinic(clinicId, (trx) => processar(trx, dep, clinicId, agora), dep.db);
}

async function processar(
  trx: Trx,
  dep: DependenciasDeAtrasos,
  clinicId: string,
  agora: Date,
): Promise<ResultadoDaClinica> {
  const saida: ResultadoDaClinica = {
    avisosAoPaciente: 0,
    alertasDeRecepcao: 0,
    alertasDeEspera: 0,
  };

  const fuso = await atrasos.fusoDaClinica(trx, clinicId);
  const { inicio, fim } = diaDaClinica(agora, fuso);
  const doDia = await atrasos.consultasDoDia(trx, inicio, fim);
  if (doDia.length === 0) return saida;

  const cfg = await atrasos.configDeAtrasos(trx, clinicId);
  const medidas = await atrasos.duracoesMedidas(trx);
  const porChave = new Map(
    medidas.map((m) => [`${m.professional_id}|${m.procedure_id}`, m] as const),
  );

  const ids = doDia.map((c) => c.id);
  const jaAvisado = await atrasos.ultimoAvisoPorConsulta(trx, ids);
  const quantosAvisos = await atrasos.contarAvisosPorConsulta(trx, ids);
  const phoneNumberId = await numeros.ativoDaClinica(trx);

  const profissionais = [...new Set(doDia.map((c) => c.professional_id))];

  for (const profissionalId of profissionais) {
    const consultas = doDia.filter((c) => c.professional_id === profissionalId);
    const paraCore: ConsultaDoDia[] = consultas.map((c) => ({
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
    const decididos = decidirAvisos(paraCore, previsao, jaAvisado, agora, {
      ...CONFIG_ATRASOS_PADRAO,
      limiarAvisoMin: cfg.limiarAvisoMin,
      janelaAvisoHoras: cfg.janelaAvisoHoras,
    });
    const avisos = respeitarLimiteDeAvisos(
      decididos,
      quantosAvisos,
      dep.maxAvisos ?? MAX_AVISOS_PADRAO,
    );

    for (const aviso of avisos) {
      const consulta = consultas.find((c) => c.id === aviso.consultaId);
      if (!consulta) continue;

      if (aviso.para === 'recepcao') {
        // Quem já está na sala não recebe WhatsApp: alguém vai falar com a
        // pessoa, que é o que ela espera de quem está a dois metros dela.
        const p = previsao.find((x) => x.id === consulta.id);
        await alertas.criar(trx, clinicId, {
          tipo: 'atraso_profissional',
          gravidade: 'atencao',
          titulo: 'Fale com quem está esperando na recepção',
          corpo: `Atraso de cerca de ${String(aviso.atrasoMin)} min. Previsão de início: ${hora(p?.inicioPrevisto ?? consulta.starts_at, fuso)}.`,
          consultaId: consulta.id,
          pacienteId: consulta.patient_id,
        });
        await atrasos.registrarAviso(trx, clinicId, {
          consultaId: consulta.id,
          canal: 'recepcao',
          atrasoMin: aviso.atrasoMin,
        });
        saida.alertasDeRecepcao += 1;
        continue;
      }

      if (phoneNumberId === undefined) continue;

      const template = aviso.tipo === 'atraso' ? TEMPLATES.atraso : TEMPLATES.normalizou;
      const enviado = await enviarAtivo(trx, dep.whatsapp, {
        clinicId,
        pacienteId: consulta.patient_id,
        phoneNumberId,
        template: template.nome,
        variaveis:
          aviso.tipo === 'atraso'
            ? [String(aviso.atrasoMin), hora(aviso.novoHorario, fuso)]
            : [hora(consulta.starts_at, fuso)],
        botoes: [...template.botoes],
        consultaId: consulta.id,
      });

      // Sem consentimento a mensagem não sai (enviarAtivo já alerta a recepção).
      // Não registrar aqui é o que faz a pessoa ser avisada de novo quando o
      // consentimento existir, em vez de o aviso sumir em silêncio.
      if (!enviado.ok) continue;

      await atrasos.registrarAviso(trx, clinicId, {
        consultaId: consulta.id,
        canal: 'whatsapp',
        atrasoMin: aviso.atrasoMin,
      });
      saida.avisosAoPaciente += 1;
    }
  }

  // Esperar 15 minutos sem ninguém dizer nada é o que faz a pessoa ir embora
  // irritada — e isso independe de o profissional estar atrasado na conta.
  const esperando = esperandoDemais(
    doDia.map((c) => ({
      id: c.id,
      inicioAgendado: c.starts_at,
      fimAgendado: c.ends_at,
      duracaoEsperadaMin: c.duracao_agenda_min,
      status: c.status,
      ...(c.checked_in_at === null ? {} : { pacienteChegouEm: c.checked_in_at }),
      ...(c.started_at === null ? {} : { iniciadaEm: c.started_at }),
    })),
    agora,
    cfg.esperaNaSalaMin,
  );

  for (const espera of esperando) {
    const consulta = doDia.find((c) => c.id === espera.consultaId);
    if (!consulta) continue;
    const paciente = await pacientes.porId(trx, consulta.patient_id);
    await alertas.criar(trx, clinicId, {
      tipo: 'espera_longa',
      gravidade: 'atencao',
      titulo: `${paciente?.name ?? 'Paciente'} espera há ${String(espera.esperandoMin)} min`,
      corpo: 'Ofereça água ou café e diga quanto tempo ainda falta.',
      consultaId: consulta.id,
      pacienteId: consulta.patient_id,
    });
    saida.alertasDeEspera += 1;
  }

  return saida;
}

/** O dia da clínica, no fuso dela — uma em Manaus vira o dia uma hora depois. */
function diaDaClinica(agora: Date, fuso: string): { inicio: Date; fim: Date } {
  // en-CA formata como AAAA-MM-DD.
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: fuso }).format(agora);
  return {
    inicio: noFuso(hoje, '00:00', fuso),
    fim: noFuso(somarDias(hoje, 1), '00:00', fuso),
  };
}

function hora(d: Date, fuso: string): string {
  return d.toLocaleTimeString('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit' });
}
