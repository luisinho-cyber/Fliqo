import { criarDb, withClinic, type Db } from '@fliqo/db';
import { criarFila, FILA_RESPOSTA, SCHEMA_FILA } from '@fliqo/db/fila';
import {
  ownerPool,
  prepararFilaDeTeste,
  resetDatabase,
  seed,
  urlDoTester,
  type Scenario,
} from '@fliqo/db/testing';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { atenderConversa, paraTurnos } from '../src/conversa';
import { enviarBalao, type BalaoDaResposta } from '../src/resposta';
import { LlmFalso, WhatsappFalso } from './fake';

let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;
let whatsapp: WhatsappFalso;
let llm: LlmFalso;
let dormiu: number[];

const PHONE_NUMBER_ID = '555000111222';
/** Segunda-feira, 09:00 em São Paulo. */
const AGORA = new Date('2026-11-09T12:00:00.000Z');

const PERFIL = {
  clinica: {
    nome: 'Clínica A',
    especialidade: 'odontologia',
    endereco: 'Rua Exemplo, 100',
  },
  persona: { nome: 'Assistente Fliqo', tratamento: 'voce', tom: 'acolhedor' },
  atendimento: { horarioHumano: 'seg a sex, 8h às 19h' },
  politicas: { cancelamento: 'avisar com 24h', formasDePagamento: ['Pix'] },
};

function dependencias() {
  return {
    db,
    boss,
    llm,
    whatsapp,
    agora: () => AGORA,
    dormir: (ms: number) => {
      dormiu.push(ms);
      return Promise.resolve();
    },
    // Sem aleatoriedade: o ritmo humano é testável, não sorteado.
    aleatorio: () => 0.5,
  };
}

/** Conversa com uma mensagem de paciente esperando resposta. */
async function conversaCom(
  textos: string[],
  opcoes: { modo?: 'ia' | 'humano'; midia?: 'audio' } = {},
): Promise<{ conversaId: string; pacienteId: string }> {
  const pacienteId = c.patients[0] as string;
  // A última mensagem chegou 2 s atrás: ainda dentro da janela de agrupamento.
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.conversations (clinic_id, patient_id, mode, last_inbound_at)
     values ($1, $2, $3, $4) returning id`,
    [c.clinicA, pacienteId, opcoes.modo ?? 'ia', new Date(AGORA.getTime() - 2_000)],
  );
  const conversaId = rows[0]!.id;
  for (const [i, texto] of textos.entries()) {
    await owner.query(
      `insert into app.messages (clinic_id, conversation_id, direction, author, wamid, body, media_kind)
       values ($1, $2, 'entrada', 'paciente', $3, $4, $5)`,
      [
        c.clinicA,
        conversaId,
        `wamid.teste.${conversaId}.${String(i)}`,
        texto,
        opcoes.midia ?? null,
      ],
    );
  }
  return { conversaId, pacienteId };
}

async function baloesNaFila(): Promise<BalaoDaResposta[]> {
  const { rows } = await owner.query<{ data: BalaoDaResposta }>(
    `select data from ${SCHEMA_FILA}.job where name = $1 order by start_after`,
    [FILA_RESPOSTA],
  );
  return rows.map((r) => r.data);
}

async function consultas(): Promise<{ starts_at: Date; source: string; patient_id: string }[]> {
  const { rows } = await owner.query<{ starts_at: Date; source: string; patient_id: string }>(
    `select starts_at, source, patient_id from app.appointments order by starts_at`,
  );
  return rows;
}

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.whatsapp_numbers (clinic_id, phone_number_id) values ($1, $2)`,
    [c.clinicA, PHONE_NUMBER_ID],
  );
  await owner.query(
    `insert into app.ai_profiles (clinic_id, version, is_active, profile) values ($1, 1, true, $2)`,
    [c.clinicA, JSON.stringify(PERFIL)],
  );
  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
  await boss.start();
}, 90_000);

afterAll(async () => {
  await boss.stop();
  await db.destroy();
  await owner.end();
});

beforeEach(async () => {
  whatsapp = new WhatsappFalso();
  llm = new LlmFalso();
  dormiu = [];
  await owner.query(`delete from ${SCHEMA_FILA}.job`);
  await owner.query('delete from app.messages');
  await owner.query('delete from app.conversations');
  await owner.query('delete from app.appointments');
  await owner.query('delete from app.alerts');
  await owner.query('delete from app.ai_usage');
  await owner.query('delete from app.waitlist_entries');
  await owner.query('update app.patients set whatsapp_consent_at = null');
});

describe('a IA pede, o código decide', () => {
  it('recusa horário que não veio de buscar_horarios', async () => {
    const { conversaId } = await conversaCom(['quero marcar limpeza terça às 14h']);
    llm
      // O modelo "inventa" um horário sem buscar: é exatamente o que não pode passar.
      .chama('marcar_consulta', {
        procedimento_id: c.procEletivo,
        inicio: '2026-11-10T17:00:00.000Z',
      })
      .diz('Desculpe, vou confirmar os horários e te falo.');

    const r = await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    expect(r.atendida).toBe(true);
    expect(await consultas()).toEqual([]);
    expect(llm.resultadoDaVolta(1)).toEqual({
      erro: expect.stringContaining('não veio de buscar_horarios'),
    });
  });

  it('aceita o horário que a própria busca devolveu', async () => {
    const { conversaId, pacienteId } = await conversaCom(['quero marcar uma limpeza']);
    llm.chama('buscar_horarios', {
      procedimento_id: c.procEletivo,
      a_partir_de: '2026-11-09',
      periodo: 'qualquer',
    });

    llm.diz('Tenho estes horários.');

    // O teste só sabe qual horário foi oferecido depois de rodar: a primeira
    // passada descobre, a segunda marca.
    const primeira = await atenderConversa(dependencias(), {
      clinicId: c.clinicA,
      conversaId,
    });
    expect(primeira.atendida).toBe(true);

    const devolvidos = llm.resultadoDaVolta(1) as { horarios: { inicio: string }[] };
    const escolhido = devolvidos.horarios[0]!.inicio;

    llm.roteiro.length = 0;
    llm.pedidos.length = 0;
    llm
      .chama('buscar_horarios', {
        procedimento_id: c.procEletivo,
        a_partir_de: '2026-11-09',
        periodo: 'qualquer',
      })
      .chama('marcar_consulta', { procedimento_id: c.procEletivo, inicio: escolhido })
      .diz('Marquei sua limpeza. Até lá!');

    const r = await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    expect(r.atendida).toBe(true);
    const marcadas = await consultas();
    expect(marcadas).toHaveLength(1);
    expect(marcadas[0]?.starts_at.toISOString()).toBe(escolhido);
    expect(marcadas[0]?.source).toBe('ia');
    expect(marcadas[0]?.patient_id).toBe(pacienteId);

    // Marcou pelo WhatsApp: o consentimento para lembrete nasce aqui (LGPD).
    const { rows } = await owner.query<{ whatsapp_consent_at: Date | null }>(
      'select whatsapp_consent_at from app.patients where id = $1',
      [pacienteId],
    );
    expect(rows[0]?.whatsapp_consent_at).not.toBeNull();
  });

  it('não deixa a IA mexer na consulta de outro paciente', async () => {
    const outro = c.patients[1] as string;
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
       values ($1,$2,$3,$4, now() + interval '2 days', now() + interval '2 days 1 hour', 25000)
       returning id`,
      [c.clinicA, c.profA, outro, c.procEletivo],
    );
    const doOutro = rows[0]!.id;

    const { conversaId } = await conversaCom(['cancela a consulta da Maria']);
    llm
      .chama('cancelar_consulta', { consulta_id: doOutro, motivo: 'pedido do paciente' })
      .diz('Não achei essa consulta no seu cadastro.');

    await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    expect(llm.resultadoDaVolta(1)).toEqual({ erro: 'consulta não encontrada' });
    const { rows: depois } = await owner.query<{ status: string }>(
      'select status from app.appointments where id = $1',
      [doOutro],
    );
    expect(depois[0]?.status).toBe('agendado');
  });

  it('recusa remarcar para horário que não veio de buscar_horarios', async () => {
    const pacienteId = c.patients[0] as string;
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
       values ($1,$2,$3,$4, $5, $6, 25000)
       returning id`,
      [
        c.clinicA,
        c.profA,
        pacienteId,
        c.procEletivo,
        new Date('2026-11-10T17:00:00.000Z'),
        new Date('2026-11-10T18:00:00.000Z'),
      ],
    );
    const minha = rows[0]!.id;

    const { conversaId } = await conversaCom(['pode passar para quarta às 15h?']);
    llm
      .chama('remarcar_consulta', {
        consulta_id: minha,
        novo_inicio: '2026-11-11T18:00:00.000Z',
      })
      .diz('Deixa eu ver os horários certinhos.');

    await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    expect(llm.resultadoDaVolta(1)).toEqual({
      erro: expect.stringContaining('não veio de buscar_horarios'),
    });
    const { rows: depois } = await owner.query<{ starts_at: Date }>(
      'select starts_at from app.appointments where id = $1',
      [minha],
    );
    expect(depois[0]?.starts_at.toISOString()).toBe('2026-11-10T17:00:00.000Z');
  });

  it('usa o paciente da conversa, não o que o modelo mandar', async () => {
    const { conversaId } = await conversaCom(['tenho consulta marcada?']);
    llm
      .chama('minhas_consultas', { patient_id: c.patientB, clinic_id: c.clinicB })
      .diz('Você não tem consulta marcada.');

    await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    // Zod derruba o que não está no schema; o executor usa o paciente da conversa.
    expect(llm.resultadoDaVolta(1)).toEqual({ consultas: [] });
  });
});

describe('quando a IA não responde', () => {
  it('cala na conversa que está com a equipe', async () => {
    const { conversaId } = await conversaCom(['e aí?'], { modo: 'humano' });
    const r = await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    expect(r).toEqual({ atendida: false, motivo: 'humano' });
    expect(llm.pedidos).toHaveLength(0);
    expect(await baloesNaFila()).toEqual([]);
  });

  it('responde emergência na hora, sem gastar um token', async () => {
    const { conversaId } = await conversaCom(['socorro, não consigo respirar']);
    const r = await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    expect(r).toMatchObject({ atendida: true, saida: 'emergencia' });
    expect(llm.pedidos).toHaveLength(0);

    const baloes = await baloesNaFila();
    expect(baloes[0]?.texto).toContain('192');

    const { rows } = await owner.query<{ kind: string; severity: string }>(
      'select kind, severity from app.alerts',
    );
    expect(rows[0]).toMatchObject({ kind: 'emergencia', severity: 'urgente' });

    const { rows: conversa } = await owner.query<{ mode: string }>(
      'select mode from app.conversations where id = $1',
      [conversaId],
    );
    expect(conversa[0]?.mode).toBe('humano');
  });

  it('passa áudio para a equipe em vez de adivinhar o que foi dito', async () => {
    const { conversaId } = await conversaCom(['[áudio]'], { midia: 'audio' });
    const r = await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    expect(r).toMatchObject({ atendida: true, saida: 'transferencia' });
    expect(llm.pedidos).toHaveLength(0);
    const { rows } = await owner.query<{ mode: string }>(
      'select mode from app.conversations where id = $1',
      [conversaId],
    );
    expect(rows[0]?.mode).toBe('humano');
  });

  it('desiste depois da segunda resposta reprovada e chama a equipe', async () => {
    const { conversaId } = await conversaCom(['quanto custa a limpeza?']);
    // R$ 900,00 não está na tabela: checarSaida barra as duas vezes.
    llm.diz('A limpeza sai por R$ 900,00.').diz('Fica R$ 900,00 mesmo.');

    const r = await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    expect(r).toMatchObject({ atendida: true, saida: 'transferencia' });
    const baloes = await baloesNaFila();
    expect(baloes.map((b) => b.texto).join(' ')).not.toContain('900');

    const { rows } = await owner.query<{ mode: string; handover_reason: string }>(
      'select mode, handover_reason from app.conversations where id = $1',
      [conversaId],
    );
    expect(rows[0]?.mode).toBe('humano');
    expect(rows[0]?.handover_reason).toContain('valor fora da tabela');
  });

  it('aceita a segunda tentativa quando o modelo corrige', async () => {
    const { conversaId } = await conversaCom(['quanto custa a limpeza?']);
    llm.diz('A limpeza sai por R$ 900,00.').diz('A limpeza custa R$ 250,00.');

    const r = await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    expect(r).toMatchObject({ atendida: true, saida: 'ia' });
    const baloes = await baloesNaFila();
    expect(baloes[0]?.texto).toContain('250,00');
    // O motivo da reprovação vai para o modelo: sem ele, ele repete o erro.
    const segundoPedido = llm.pedidos[1]!;
    expect(JSON.stringify(segundoPedido.turnos)).toContain('valor fora da tabela');
  });
});

describe('histórico virando turnos', () => {
  it('começa pelo paciente, mesmo quando a clínica falou primeiro', () => {
    // Lembrete enviado antes de o paciente escrever: a API recusa um histórico
    // que abre com a clínica falando.
    const turnos = paraTurnos([
      { author: 'ia', body: 'Lembrete da sua consulta amanhã.' },
      { author: 'paciente', body: 'oi' },
    ]);
    expect(turnos).toHaveLength(1);
    expect(turnos[0]?.papel).toBe('paciente');
  });

  it('junta mensagens seguidas do mesmo lado em um turno só', () => {
    const turnos = paraTurnos([
      { author: 'paciente', body: 'oi' },
      { author: 'paciente', body: 'queria marcar' },
      { author: 'ia', body: 'Claro!' },
      { author: 'paciente', body: 'limpeza' },
    ]);
    expect(turnos.map((t) => t.papel)).toEqual(['paciente', 'assistente', 'paciente']);
    expect(turnos[0]?.blocos).toHaveLength(2);
  });

  it('trata mensagem sem texto sem quebrar o turno', () => {
    const turnos = paraTurnos([{ author: 'paciente', body: null }]);
    expect(turnos[0]?.blocos[0]).toEqual({ tipo: 'texto', texto: '[mensagem sem texto]' });
  });
});

describe('ritmo e contabilidade', () => {
  it('junta mensagens picadas em uma entrada só', async () => {
    const { conversaId } = await conversaCom(['oi', 'queria marcar', 'uma limpeza']);
    llm.diz('Claro! Posso ver os horários.');

    await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    // Uma chamada ao modelo, não três.
    expect(llm.pedidos).toHaveLength(1);
    expect(dormiu).toHaveLength(1);
    expect(dormiu[0]).toBeGreaterThan(0);
  });

  it('agenda os balões atrasados, em ordem, em vez de despejar tudo de uma vez', async () => {
    const { conversaId } = await conversaCom(['oi']);
    llm.diz(
      'Oi! Tudo bem? Eu cuido da agenda aqui da clínica e posso marcar para você. ' +
        'Me diz qual procedimento você quer que eu já vejo os horários livres. ' +
        'Se preferir, também consigo ver com qual profissional você já se consultou antes.',
    );

    const r = await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    expect(r).toMatchObject({ atendida: true, saida: 'ia' });
    const baloes = await baloesNaFila();
    expect(baloes.length).toBeGreaterThan(1);
    expect(baloes.every((b) => b.digitandoMs > 0)).toBe(true);

    const { rows } = await owner.query<{ n: string }>(
      `select count(*) as n from ${SCHEMA_FILA}.job where name = $1 and start_after > now()`,
      [FILA_RESPOSTA],
    );
    expect(Number(rows[0]?.n)).toBe(baloes.length);
  });

  it('registra os tokens gastos por clínica', async () => {
    const { conversaId } = await conversaCom(['oi']);
    llm.diz('Oi! Como posso ajudar com a agenda?');

    await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });

    const { rows } = await owner.query<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      conversation_id: string;
    }>('select model, input_tokens, output_tokens, conversation_id from app.ai_usage');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: 'modelo-de-teste',
      input_tokens: 100,
      output_tokens: 20,
      conversation_id: conversaId,
    });
  });

  it('não envia o balão se a recepção assumiu a conversa no meio do caminho', async () => {
    const { conversaId } = await conversaCom(['oi']);
    llm.diz('Oi! Como posso ajudar?');
    await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });
    const balao = (await baloesNaFila())[0]!;

    // Entre planejar e enviar, a clínica respondeu pelo celular.
    await owner.query(`update app.conversations set mode = 'humano' where id = $1`, [conversaId]);

    const r = await withClinic(c.clinicA, (trx) => enviarBalao(trx, whatsapp, balao), db);

    expect(r).toEqual({ ok: false, motivo: 'humano' });
    expect(whatsapp.textos).toEqual([]);
  });

  it('envia o balão e grava no histórico quando a conversa ainda é da IA', async () => {
    const { conversaId } = await conversaCom(['oi']);
    llm.diz('Oi! Como posso ajudar?');
    await atenderConversa(dependencias(), { clinicId: c.clinicA, conversaId });
    const balao = (await baloesNaFila())[0]!;

    const r = await withClinic(c.clinicA, (trx) => enviarBalao(trx, whatsapp, balao), db);

    expect(r.ok).toBe(true);
    expect(whatsapp.textos[0]?.texto).toBe(balao.texto);
    expect(whatsapp.digitando).toHaveLength(1);

    const { rows } = await owner.query<{ author: string; body: string }>(
      `select author, body from app.messages where direction = 'saida'`,
    );
    expect(rows[0]).toMatchObject({ author: 'ia', body: balao.texto });
  });
});
