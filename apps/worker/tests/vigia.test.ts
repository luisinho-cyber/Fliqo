import { criarDb, operador, withClinic, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, urlDoTester } from '@fliqo/db/testing';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigDeEmail } from '../src/email';
import { vigiarOperador } from '../src/vigia-de-operador';

/**
 * O vigia de operador, contra o banco de verdade e com um serviço de e-mail falso.
 *
 * Os dois testes que o enunciado nomeou estão aqui — a clínica em silêncio com ação vencida
 * dispara, e a clínica sem nada marcado não —, e eles são o par: um alerta que dispara sempre
 * e um que nunca dispara são igualmente inúteis, e só os dois juntos provam que o gatilho
 * discrimina.
 *
 * Nenhum e-mail sai desta máquina: o `fetch` do remetente é substituído.
 */

const CHAVE_FALSA = 'CHAVE_DE_EMAIL_FALSA_DE_TESTE_NAO_USE_123456';
interface EmailEnviado {
  url: string;
  autorizacao: string;
  assunto: string;
  texto: string;
  para: string[];
}

const enviados: EmailEnviado[] = [];

const emailFalso: ConfigDeEmail = {
  chave: CHAVE_FALSA,
  remetente: 'avisos@exemplo.invalido',
  destinatario: 'operador@exemplo.invalido',
  url: 'https://email.exemplo.invalido/enviar',
  buscar: ((url: string, init?: RequestInit) => {
    const corpo = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const cabecalhos = (init?.headers ?? {}) as Record<string, string>;
    enviados.push({
      url,
      autorizacao: cabecalhos['authorization'] ?? '',
      assunto: String(corpo.subject ?? ''),
      texto: String(corpo.text ?? ''),
      para: (corpo.to ?? []) as string[],
    });
    return Promise.resolve(Response.json({ id: 'email-falso' }));
  }) as unknown as typeof fetch,
};

let owner: pg.Pool;
let db: Db;

async function criarClinica(nome: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.clinics (name, timezone) values ($1, 'America/Sao_Paulo') returning id`,
    [nome],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('clínica não criada');
  return id;
}

/** Uma ação de envio que venceu há `minutos`. É o "tinha o que mandar". */
async function acaoVencida(clinicId: string, minutos = 30): Promise<void> {
  await owner.query(
    `insert into app.scheduled_actions (clinic_id, kind, due_at)
     values ($1, 'confirmacao', now() - make_interval(mins => $2::int))`,
    [clinicId, minutos],
  );
}

/**
 * Roda o vigia com o portão de horário ABERTO.
 *
 * O portão tem teste próprio em packages/core, com as bordas e o fim de semana. Aqui ele é
 * aberto de propósito: as janelas que estes testes medem — ação vencida há 30 min, alerta há
 * 40 — são relativas ao `now()` do banco, e um `agora` fixo escolhido para satisfazer o portão
 * mediria a distância entre duas datas em vez da regra. Os dois casos do portão abaixo usam a
 * regra de verdade.
 */
function rodar(agora = new Date()) {
  return vigiarOperador({
    db,
    email: emailFalso,
    fusoDoOperador: 'America/Sao_Paulo',
    agora: () => agora,
    horarioPermitido: () => true,
  });
}

/** Roda com o portão de verdade, para os dois casos que testam o portão pela borda do job. */
function rodarComPortao(agora: Date) {
  return vigiarOperador({
    db,
    email: emailFalso,
    fusoDoOperador: 'America/Sao_Paulo',
    agora: () => agora,
  });
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  db = criarDb(urlDoTester());
}, 90_000);

afterAll(async () => {
  await owner.end();
  await db.destroy();
});

beforeEach(async () => {
  enviados.length = 0;
  await owner.query('delete from app.operator_notices');
  await owner.query('delete from app.scheduled_actions');
  await owner.query('delete from app.alerts');
  await owner.query('delete from app.clinics');
});

describe('clínica em silêncio com ação vencida dispara', () => {
  it('manda um e-mail, dizendo quantas ações venceram', async () => {
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);
    await acaoVencida(clinica);

    const r = await rodar();

    expect(r.rodou).toBe(true);
    expect(r.avisadas).toBe(1);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.assunto).toContain('Clínica Muda');
    expect(enviados[0]?.texto).toContain('2 ação');
    expect(enviados[0]?.para).toEqual(['operador@exemplo.invalido']);
  });

  it('grava o envio, para o reenvio ter de onde contar', async () => {
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);
    await rodar();

    const avisos = await withClinic(clinica, (trx) => operador.avisosDaClinica(trx), db);
    expect(avisos.get('silencio')?.envios).toBe(1);
  });
});

describe('clínica sem nada marcado NÃO dispara', () => {
  it('zero mensagem e zero ação vencida é o estado normal de quem está fechado', async () => {
    // Fim de semana, feriado, clínica nova. Sem esta condição, toda clínica sem consulta
    // viraria e-mail e o operador aprenderia a ignorar o aviso.
    await criarClinica('Clínica Fechada');

    const r = await rodar();

    expect(r.rodou).toBe(true);
    expect(r.clinicasVistas).toBe(1);
    expect(r.avisadas).toBe(0);
    expect(enviados).toEqual([]);
  });

  it('clínica que mandou mensagem na janela também não dispara', async () => {
    const clinica = await criarClinica('Clínica Ativa');
    await acaoVencida(clinica);

    const paciente = await owner.query<{ id: string }>(
      `insert into app.patients (clinic_id, name, phone_e164)
       values ($1, 'Maria', '+5511900000001') returning id`,
      [clinica],
    );
    const conversa = await owner.query<{ id: string }>(
      `insert into app.conversations (clinic_id, patient_id) values ($1, $2) returning id`,
      [clinica, paciente.rows[0]?.id],
    );
    await owner.query(
      `insert into app.messages (clinic_id, conversation_id, direction, author, body)
       values ($1, $2, 'saida', 'sistema', 'confirmação')`,
      [clinica, conversa.rows[0]?.id],
    );

    const r = await rodar();
    expect(r.avisadas).toBe(0);
    expect(enviados).toEqual([]);
  });
});

describe('WhatsApp fora, com a carência de vinte minutos', () => {
  async function comAlertaDe(minutos: number): Promise<string> {
    const clinica = await criarClinica('Clínica Fora');
    await owner.query(
      `insert into app.alerts (clinic_id, kind, severity, title, created_at)
       values ($1, 'whatsapp_fora', 'urgente', 'fora', now() - make_interval(mins => $2::int))`,
      [clinica, minutos],
    );
    return clinica;
  }

  it('dez minutos não dispara', async () => {
    await comAlertaDe(10);
    expect((await rodar()).avisadas).toBe(0);
  });

  it('quarenta minutos dispara, e a frase diz há quanto tempo', async () => {
    await comAlertaDe(40);
    const r = await rodar();
    expect(r.avisadas).toBe(1);
    expect(enviados[0]?.texto).toMatch(/WhatsApp fora há \d+ min/);
  });
});

describe('reenvio enquanto a causa persiste, com teto', () => {
  it('não reenvia antes de uma hora', async () => {
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);

    const inicio = new Date();
    await rodar(inicio);
    // Quinze minutos depois, o laço roda de novo e a causa continua.
    const r = await rodar(new Date(inicio.getTime() + 15 * 60_000));

    expect(r.avisadas).toBe(0);
    expect(r.calados[0]?.motivo).toBe('muito_recente');
    expect(enviados).toHaveLength(1);
  });

  it('reenvia depois de uma hora', async () => {
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);

    const inicio = new Date();
    await rodar(inicio);
    await rodar(new Date(inicio.getTime() + 61 * 60_000));

    expect(enviados).toHaveLength(2);
    const avisos = await withClinic(clinica, (trx) => operador.avisosDaClinica(trx), db);
    expect(avisos.get('silencio')?.envios).toBe(2);
  });

  it('para no teto, mesmo com a causa de pé', async () => {
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);

    // Seis envios, de hora em hora. O sétimo não sai.
    const inicio = new Date();
    for (let i = 0; i < 7; i++) {
      await rodar(new Date(inicio.getTime() + i * 61 * 60_000));
    }

    expect(enviados).toHaveLength(6);
    const ultimo = await rodar(new Date(inicio.getTime() + 8 * 61 * 60_000));
    expect(ultimo.calados[0]?.motivo).toBe('teto_atingido');
  });

  it('a causa que passa rearma o teto: o próximo episódio avisa de novo', async () => {
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);
    const inicio = new Date();
    for (let i = 0; i < 7; i++) {
      await rodar(new Date(inicio.getTime() + i * 61 * 60_000));
    }
    expect(enviados).toHaveLength(6);

    // A clínica volta ao normal: a ação vencida sai de cena.
    await owner.query('delete from app.scheduled_actions where clinic_id = $1', [clinica]);
    const limpeza = await rodar(new Date(inicio.getTime() + 9 * 61 * 60_000));
    expect(limpeza.esquecidas).toBeGreaterThanOrEqual(1);

    // E cai de novo amanhã.
    await acaoVencida(clinica);
    enviados.length = 0;
    const denovo = await rodar(new Date(inicio.getTime() + 10 * 61 * 60_000));
    expect(denovo.avisadas).toBe(1);
    expect(enviados).toHaveLength(1);
  });

  it('e-mail que falhou não consome o teto', async () => {
    // Chave errada não pode silenciar o aviso para sempre depois de seis tentativas falhas.
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);

    const quebrado: ConfigDeEmail = {
      ...emailFalso,
      buscar: () => Promise.resolve(Response.json({ erro: 'chave invalida' }, { status: 401 })),
    };
    const r = await vigiarOperador({
      db,
      email: quebrado,
      fusoDoOperador: 'America/Sao_Paulo',
      horarioPermitido: () => true,
    });

    expect(r.avisadas).toBe(0);
    expect(r.falhas).toHaveLength(1);
    const avisos = await withClinic(clinica, (trx) => operador.avisosDaClinica(trx), db);
    expect(avisos.size).toBe(0);
  });
});

describe('fora do horário de operação, nem lê o banco', () => {
  it('três da manhã não manda nada e não marca nada', async () => {
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);

    // 06:00 UTC = 03:00 em São Paulo.
    const r = await rodarComPortao(new Date('2026-10-14T06:00:00Z'));

    expect(r.rodou).toBe(false);
    expect(r.clinicasVistas).toBe(0);
    expect(enviados).toEqual([]);
    const avisos = await withClinic(clinica, (trx) => operador.avisosDaClinica(trx), db);
    expect(avisos.size).toBe(0);
  });

  it('sábado também não', async () => {
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);
    expect((await rodarComPortao(new Date('2026-10-17T17:00:00Z'))).rodou).toBe(false);
  });
});

describe('o e-mail não leva segredo nem dado de paciente', () => {
  it('a chave vai no cabeçalho e não no corpo', async () => {
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);
    await rodar();

    const email = enviados[0];
    expect(email?.autorizacao).toBe(`Bearer ${CHAVE_FALSA}`);
    // E não no texto que alguém pode encaminhar sem pensar.
    expect(email?.texto).not.toContain(CHAVE_FALSA);
    expect(email?.assunto).not.toContain(CHAVE_FALSA);
  });

  it('nem telefone, nem nome de paciente, nem conteúdo de mensagem', async () => {
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);

    const paciente = await owner.query<{ id: string }>(
      `insert into app.patients (clinic_id, name, phone_e164)
       values ($1, 'Fulana Secreta', '+5511987654321') returning id`,
      [clinica],
    );
    const conversa = await owner.query<{ id: string }>(
      `insert into app.conversations (clinic_id, patient_id) values ($1, $2) returning id`,
      [clinica, paciente.rows[0]?.id],
    );
    await owner.query(
      `insert into app.messages (clinic_id, conversation_id, direction, author, body, created_at)
       values ($1, $2, 'saida', 'ia', 'texto que nao pode vazar', now() - interval '9 hours')`,
      [clinica, conversa.rows[0]?.id],
    );

    await rodar();
    const tudo = JSON.stringify(enviados);
    expect(tudo).not.toContain('Fulana Secreta');
    expect(tudo).not.toContain('987654321');
    expect(tudo).not.toContain('texto que nao pode vazar');
  });

  it('o resumo que vai para o log não leva chave nem endereço', async () => {
    // O resumo é o que o `log.info` publica. Id de clínica é aceitável e aparece em `calados`
    // e `falhas`; chave e caixa de entrada do operador, nunca.
    const clinica = await criarClinica('Clínica Muda');
    await acaoVencida(clinica);
    const inicio = new Date();
    await rodar(inicio);
    // Segunda volta, para haver um `calado` com id de clínica no resumo.
    const r = await rodar(new Date(inicio.getTime() + 60_000));

    const resumo = JSON.stringify(r);
    expect(resumo).not.toContain(CHAVE_FALSA);
    expect(resumo).not.toContain('operador@exemplo.invalido');
    expect(resumo).not.toContain('avisos@exemplo.invalido');
    // Id de clínica, sim: é o que torna o log útil, e não identifica pessoa.
    expect(r.calados[0]?.clinicId).toBe(clinica);
  });
});
