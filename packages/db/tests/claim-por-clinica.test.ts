import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appPool, ownerPool, resetDatabase } from './helpers';

/**
 * `app.claim_due_actions` olha o número de CADA clínica, não "algum número em erro".
 *
 * A função é `security definer` e cruza clínicas de propósito: o worker reclama o lote sem
 * clínica na transação, e a RLS não tem tenant para filtrar. Essa é a trava toda — a
 * correlação `w.clinic_id = a.clinic_id` no `exists` é o único lugar que impede o WhatsApp
 * de uma clínica de decidir pelas ações das outras.
 *
 * Sem ela a falha é das silenciosas e das caras: uma clínica com o token expirado
 * seguraria a régua de confirmação de TODAS as clínicas da instância, sem erro, sem alerta,
 * e sem nada na tela — as mensagens simplesmente não sairiam. É o tipo de defeito que só
 * aparece quando a segunda clínica entra em produção, que é tarde.
 *
 * O teste não cria consulta nenhuma: o claim não lê `appointments`, e `appointment_id` nulo
 * evita o gatilho `appointments_sync_actions`, que criaria ações extras e tornaria a
 * contagem aproximada. Menos peça entre a afirmação e a coisa afirmada.
 */

let owner: pg.Pool;
let app: pg.Pool;
let clinicaA: string;
let clinicaB: string;

type Estado = 'conectado' | 'erro';

async function criarClinica(nome: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.clinics (name, timezone) values ($1, 'America/Sao_Paulo') returning id`,
    [nome],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`a clínica ${nome} não foi criada`);
  return id;
}

/**
 * O número da clínica, ativo, no estado pedido.
 *
 * Os três campos do token são bytes falsos, e não um token cifrado de verdade: eles existem
 * só para satisfazer `token_completo` e `conectado_tem_token` (0005) — "conectado sem token"
 * não existe no banco. O claim nunca decifra nada, então o conteúdo é irrelevante e valor
 * real aqui seria segredo plantado em fixture sem motivo.
 */
async function numero(clinic: string, phoneNumberId: string, status: Estado): Promise<void> {
  await owner.query(
    `insert into app.whatsapp_numbers
       (clinic_id, phone_number_id, active, status, token_ciphertext, token_iv, token_tag,
        token_updated_at)
     values ($1, $2, true, $3,
             decode('00000000000000000000000000000000', 'hex'),
             decode('000000000000000000000000', 'hex'),
             decode('00000000000000000000000000000000', 'hex'),
             now())
     on conflict (phone_number_id) do update set status = excluded.status`,
    [clinic, phoneNumberId, status],
  );
}

/** Uma ação pendente e vencida. `confirmacao` manda mensagem; `marcar_risco` não. */
async function acaoVencida(clinic: string, kind: 'confirmacao' | 'marcar_risco'): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.scheduled_actions (clinic_id, kind, due_at)
     values ($1, $2, now() - interval '5 minutes') returning id`,
    [clinic, kind],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('a ação não foi criada');
  return id;
}

/**
 * Reclama o lote como a APLICAÇÃO e sem clínica na transação, que é exatamente como o worker
 * faz (`apps/worker/src/acoes.ts`). Chamar como dono do schema esconderia justamente o que
 * a função `security definer` existe para permitir.
 */
async function reclamar(limite = 50): Promise<{ id: string; clinic_id: string; kind: string }[]> {
  const { rows } = await app.query<{ id: string; clinic_id: string; kind: string }>(
    'select id, clinic_id, kind from app.claim_due_actions($1)',
    [limite],
  );
  return rows;
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  app = appPool();
  clinicaA = await criarClinica('Clínica A');
  clinicaB = await criarClinica('Clínica B');
}, 60_000);

afterAll(async () => {
  await owner.end();
  await app.end();
});

beforeEach(async () => {
  // Cada caso monta a própria mesa: ação reclamada fica em 'executando' e não volta.
  await owner.query('delete from app.scheduled_actions');
  await owner.query('delete from app.whatsapp_numbers');
});

describe('o número de uma clínica não decide pelas ações da outra', () => {
  it('A saudável e B em erro: as ações de envio da A saem, as da B não', async () => {
    await numero(clinicaA, 'numero-da-A', 'conectado');
    await numero(clinicaB, 'numero-da-B', 'erro');
    const daA = await acaoVencida(clinicaA, 'confirmacao');
    const daB = await acaoVencida(clinicaB, 'confirmacao');

    const lote = await reclamar();
    const ids = lote.map((l) => l.id);

    expect(ids).toContain(daA);
    expect(ids).not.toContain(daB);
    // Nenhuma ação da B no lote inteiro, sob nenhum pretexto.
    expect(lote.filter((l) => l.clinic_id === clinicaB)).toEqual([]);
  });

  it('e vice-versa: A em erro e B saudável, só as da B saem', async () => {
    await numero(clinicaA, 'numero-da-A', 'erro');
    await numero(clinicaB, 'numero-da-B', 'conectado');
    const daA = await acaoVencida(clinicaA, 'confirmacao');
    const daB = await acaoVencida(clinicaB, 'confirmacao');

    const lote = await reclamar();
    const ids = lote.map((l) => l.id);

    expect(ids).toContain(daB);
    expect(ids).not.toContain(daA);
    expect(lote.filter((l) => l.clinic_id === clinicaA)).toEqual([]);
  });

  it('as duas saudáveis: as duas saem — o lote não é cego, é seletivo', async () => {
    // O controle. Sem ele, uma função que não reclamasse NADA passaria nos dois testes
    // acima pela metade errada.
    await numero(clinicaA, 'numero-da-A', 'conectado');
    await numero(clinicaB, 'numero-da-B', 'conectado');
    const daA = await acaoVencida(clinicaA, 'confirmacao');
    const daB = await acaoVencida(clinicaB, 'confirmacao');

    const ids = (await reclamar()).map((l) => l.id);
    expect(ids).toContain(daA);
    expect(ids).toContain(daB);
  });

  it('as duas em erro: nenhuma ação de envio sai, de nenhuma das duas', async () => {
    await numero(clinicaA, 'numero-da-A', 'erro');
    await numero(clinicaB, 'numero-da-B', 'erro');
    await acaoVencida(clinicaA, 'confirmacao');
    await acaoVencida(clinicaB, 'confirmacao');

    expect(await reclamar()).toEqual([]);
  });

  it('a clínica em erro continua entregando o que NÃO manda mensagem', async () => {
    // `marcar_risco` não fala com o paciente: segurá-la não protegeria nada e deixaria a
    // recepção sem o aviso de consulta em risco justamente no dia em que o WhatsApp caiu.
    await numero(clinicaA, 'numero-da-A', 'erro');
    await numero(clinicaB, 'numero-da-B', 'conectado');
    const risco = await acaoVencida(clinicaA, 'marcar_risco');
    const envio = await acaoVencida(clinicaA, 'confirmacao');

    const ids = (await reclamar()).map((l) => l.id);
    expect(ids).toContain(risco);
    expect(ids).not.toContain(envio);
  });

  it('o lote só traz clínica cujo PRÓPRIO número está são', async () => {
    /*
     * A afirmação geral, num cenário de três clínicas: para toda ação de envio reclamada, o
     * número da clínica DELA não pode estar em erro. É a invariante que a correlação do
     * `exists` garante, escrita como invariante e não como caso.
     */
    const clinicaC = await criarClinica('Clínica C');
    await numero(clinicaA, 'numero-da-A', 'conectado');
    await numero(clinicaB, 'numero-da-B', 'erro');
    await numero(clinicaC, 'numero-da-C', 'conectado');
    for (const clinica of [clinicaA, clinicaB, clinicaC]) {
      await acaoVencida(clinica, 'confirmacao');
    }

    const lote = await reclamar();
    const emErro = new Set([clinicaB]);
    const clinicasNoLote = new Set(
      lote.filter((l) => l.kind === 'confirmacao').map((l) => l.clinic_id),
    );

    expect([...clinicasNoLote].filter((id) => emErro.has(id))).toEqual([]);
    expect(clinicasNoLote).toEqual(new Set([clinicaA, clinicaC]));
  });

  it('clínica sem número nenhum não é confundida com clínica em erro', async () => {
    // O `exists` é sobre existir número EM ERRO. Nenhum número é outra situação: a ação sai,
    // e é o caminho de envio que falha com "clínica sem número de WhatsApp" — com alerta.
    await numero(clinicaB, 'numero-da-B', 'erro');
    const semNumero = await acaoVencida(clinicaA, 'confirmacao');

    expect((await reclamar()).map((l) => l.id)).toContain(semNumero);
  });

  it('número desativado em erro não segura ninguém', async () => {
    // `active and status = 'erro'`: número desativado é outra história, e o caminho de envio
    // já para antes dele, em `ativoDaClinica`.
    await owner.query(
      `insert into app.whatsapp_numbers (clinic_id, phone_number_id, active, status)
       values ($1, 'numero-velho-da-A', false, 'erro')`,
      [clinicaA],
    );
    await numero(clinicaA, 'numero-da-A', 'conectado');
    const daA = await acaoVencida(clinicaA, 'confirmacao');

    expect((await reclamar()).map((l) => l.id)).toContain(daA);
  });
});
