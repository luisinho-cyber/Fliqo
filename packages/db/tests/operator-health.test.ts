import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { criarDb, operador, withClinic, type Db } from '../src/index';
import { appPool, ownerPool, resetDatabase, urlDoTester } from './helpers';

/**
 * A sexta função security definer, e o portão que a mantém honesta.
 *
 * Ela cruza clínicas por uma razão nova: a pergunta é do operador, e a resposta é sobre todas
 * as clínicas de uma vez. As cinco anteriores cruzam porque algo acontece antes de haver
 * clínica na transação; esta não tem essa desculpa. O que a torna aceitável é o RETORNO.
 *
 * Então o teste mais importante deste arquivo não é se a contagem está certa: é o que falha
 * quando alguém acrescenta uma coluna identificável ao retorno. Uma linha de paciente aqui
 * sairia do banco, entraria num e-mail e pousaria na caixa de entrada do fundador — fora de
 * qualquer tela, fora de qualquer RLS, e sem ninguém notar.
 */

/**
 * As colunas que o retorno PODE ter, fixadas por valor.
 *
 * Lista de permissão e não de proibição: proibição exige adivinhar o nome que a próxima pessoa
 * vai escolher, e `patient_phone` passaria num filtro que procura `telefone`. Aqui, qualquer
 * coluna nova reprova até alguém decidir que ela é agregada.
 *
 * `clinic_name` entra porque nome de clínica é dado de EMPRESA: sem ele o e-mail obriga o
 * operador a abrir o banco para saber de quem se trata, e aí o aviso deixa de ser acionável.
 */
const COLUNAS_PERMITIDAS = [
  'clinic_id',
  'clinic_name',
  'whatsapp_fora_desde',
  'enviadas_ultima_hora',
  'enviadas_na_janela',
  'vencidas_na_janela',
  // A oitava, pela 0016: a fila de envio represada NESTE instante, que é o que o /health do
  // worker usa. Entrou porque a lista caiu quando ela apareceu — o portão funcionando — e
  // porque ela cabe no mesmo contrato: é uma contagem.
  'vencidas_pendentes',
  'qualidade',
] as const;

/**
 * Pedaços de nome que denunciam dado de pessoa. A segunda rede, depois da lista de permissão.
 *
 * Ela existe para o caso em que alguém AMPLIA a lista de permissão sem pensar: o nome
 * `patient_id` reprova aqui mesmo que tenha sido autorizado lá.
 */
const PROIBIDOS = [
  'patient',
  'paciente',
  'phone',
  'telefone',
  'wamid',
  'body',
  'corpo',
  'message_text',
  'email',
  'cpf',
];

let owner: pg.Pool;
let app: pg.Pool;
let db: Db;
let clinicaA: string;
let clinicaB: string;

async function criarClinica(nome: string, opcoes: { demo?: boolean } = {}): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.clinics (name, timezone, is_demo)
     values ($1, 'America/Sao_Paulo', $2) returning id`,
    [nome, opcoes.demo ?? false],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`a clínica ${nome} não foi criada`);
  return id;
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  app = appPool();
  db = criarDb(urlDoTester());
  clinicaA = await criarClinica('Clínica A');
  clinicaB = await criarClinica('Clínica B');
}, 90_000);

afterAll(async () => {
  await owner.end();
  await app.end();
  await db.destroy();
});

describe('o retorno da função é agregado, e nada além disso', () => {
  it('as colunas são exatamente as oito permitidas', async () => {
    // Lido do catálogo, não do código: é o que o Postgres de fato devolve.
    const { rows } = await owner.query<{ assinatura: string }>(
      `select pg_get_function_result(oid) as assinatura
         from pg_proc where proname = 'operator_health' and pronamespace = 'app'::regnamespace`,
    );
    const assinatura = rows[0]?.assinatura ?? '';
    expect(assinatura, 'a função operator_health não existe').not.toBe('');

    const colunas = [...assinatura.matchAll(/(\w+)\s+(?:uuid|text|bigint|timestamp[\w ]*|int\w*)/g)]
      .map((m) => m[1] ?? '')
      .filter((c) => c !== '');

    expect(colunas.sort()).toEqual([...COLUNAS_PERMITIDAS].sort());
  });

  it('nenhum nome de coluna do retorno lembra dado de pessoa', async () => {
    const { rows } = await owner.query<{ assinatura: string }>(
      `select pg_get_function_result(oid) as assinatura
         from pg_proc where proname = 'operator_health' and pronamespace = 'app'::regnamespace`,
    );
    const assinatura = (rows[0]?.assinatura ?? '').toLowerCase();
    for (const proibido of PROIBIDOS) {
      expect(assinatura, `o retorno tem "${proibido}"`).not.toContain(proibido);
    }
  });

  it('o corpo da função não seleciona coluna identificável de nenhuma tabela', async () => {
    /*
     * A terceira rede, e a que pega o caso mais perigoso: alguém que leia `app.messages.body`
     * para "melhorar o diagnóstico" e o devolva numa coluna de nome inocente como `amostra`.
     *
     * `app.messages` PODE ser lida — é de lá que sai a contagem —, mas só como `count(*)`.
     */
    const { rows } = await owner.query<{ corpo: string }>(
      `select pg_get_functiondef(oid) as corpo
         from pg_proc where proname = 'operator_health' and pronamespace = 'app'::regnamespace`,
    );
    const corpo = (rows[0]?.corpo ?? '').toLowerCase();

    for (const agulha of ['phone_e164', 'patient_id', 'wamid', 'm.body', 'app.patients']) {
      expect(corpo, `o corpo da função toca "${agulha}"`).not.toContain(agulha);
    }
    // E a prova positiva: a leitura de mensagens é contagem.
    expect(corpo).toContain('count(*)');
  });

  it('é security definer, stable, e com search_path fixo', async () => {
    const { rows } = await owner.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
    }>(
      `select prosecdef, provolatile, proconfig
         from pg_proc where proname = 'operator_health' and pronamespace = 'app'::regnamespace`,
    );
    const f = rows[0];
    expect(f?.prosecdef, 'deixou de ser security definer').toBe(true);
    // `stable` e não `volatile`: ela só lê. Se um dia escrever, isto cai primeiro.
    expect(f?.provolatile).toBe('s');
    expect(f?.proconfig).toContain('search_path=app, pg_temp');
  });

  it('o papel da aplicação executa; o público não', async () => {
    const { rows } = await owner.query<{ app: boolean; publico: boolean }>(
      `select has_function_privilege('fliqo_app', 'app.operator_health(int)', 'execute') as app,
              has_function_privilege('public',    'app.operator_health(int)', 'execute') as publico`,
    );
    expect(rows[0]?.app).toBe(true);
    expect(rows[0]?.publico).toBe(false);
  });
});

describe('o que a função mede', () => {
  it('clínica sem nada devolve zeros e nulos, não erro', async () => {
    const saudes = await operador.saudeDasClinicas(db);
    const a = saudes.find((s) => s.clinicId === clinicaA);
    expect(a).toBeDefined();
    expect(a?.enviadasNaUltimaHora).toBe(0);
    expect(a?.vencidasNaJanela).toBe(0);
    expect(a?.whatsappForaDesde).toBeNull();
    expect(a?.qualidade).toBeNull();
  });

  it('conta mensagem de SAÍDA, não de entrada', async () => {
    // Mensagem recebida não prova que a clínica consegue enviar — e é exatamente a clínica
    // que recebe e não responde que o vigia precisa pegar.
    const paciente = await owner.query<{ id: string }>(
      `insert into app.patients (clinic_id, name, phone_e164)
       values ($1, 'Maria', '+5511900000001') returning id`,
      [clinicaA],
    );
    const conversa = await owner.query<{ id: string }>(
      `insert into app.conversations (clinic_id, patient_id) values ($1, $2) returning id`,
      [clinicaA, paciente.rows[0]?.id],
    );
    const conversaId = conversa.rows[0]?.id;

    await owner.query(
      `insert into app.messages (clinic_id, conversation_id, direction, author, body)
       values ($1, $2, 'entrada', 'paciente', 'oi')`,
      [clinicaA, conversaId],
    );
    let a = (await operador.saudeDasClinicas(db)).find((s) => s.clinicId === clinicaA);
    expect(a?.enviadasNaUltimaHora).toBe(0);

    await owner.query(
      `insert into app.messages (clinic_id, conversation_id, direction, author, body)
       values ($1, $2, 'saida', 'ia', 'bom dia')`,
      [clinicaA, conversaId],
    );
    a = (await operador.saudeDasClinicas(db)).find((s) => s.clinicId === clinicaA);
    expect(a?.enviadasNaUltimaHora).toBe(1);
  });

  it('conta como "deveria ter saído" só ação que ENVIA', async () => {
    // `marcar_risco` não fala com o paciente: contá-la faria toda clínica com consulta em
    // risco parecer muda. Quem decide é `app.action_kind_envia`, não uma lista repetida.
    await owner.query(
      `insert into app.scheduled_actions (clinic_id, kind, due_at)
       values ($1, 'marcar_risco', now() - interval '10 minutes')`,
      [clinicaB],
    );
    let b = (await operador.saudeDasClinicas(db)).find((s) => s.clinicId === clinicaB);
    expect(b?.vencidasNaJanela).toBe(0);

    await owner.query(
      `insert into app.scheduled_actions (clinic_id, kind, due_at)
       values ($1, 'confirmacao', now() - interval '10 minutes')`,
      [clinicaB],
    );
    b = (await operador.saudeDasClinicas(db)).find((s) => s.clinicId === clinicaB);
    expect(b?.vencidasNaJanela).toBe(1);
  });

  it('ação que ainda não venceu não conta', async () => {
    const antes = (await operador.saudeDasClinicas(db)).find((s) => s.clinicId === clinicaB);
    await owner.query(
      `insert into app.scheduled_actions (clinic_id, kind, due_at)
       values ($1, 'lembrete_final', now() + interval '2 hours')`,
      [clinicaB],
    );
    const depois = (await operador.saudeDasClinicas(db)).find((s) => s.clinicId === clinicaB);
    expect(depois?.vencidasNaJanela).toBe(antes?.vencidasNaJanela);
  });

  it('o alerta whatsapp_fora aberto carimba desde quando', async () => {
    await owner.query(
      `insert into app.alerts (clinic_id, kind, severity, title, created_at)
       values ($1, 'whatsapp_fora', 'urgente', 'fora', now() - interval '45 minutes')`,
      [clinicaA],
    );
    const a = (await operador.saudeDasClinicas(db)).find((s) => s.clinicId === clinicaA);
    expect(a?.whatsappForaDesde).toBeInstanceOf(Date);
    const min = (Date.now() - (a?.whatsappForaDesde?.getTime() ?? 0)) / 60_000;
    expect(min).toBeGreaterThan(40);
  });

  it('alerta resolvido deixa de carimbar', async () => {
    await owner.query(
      `update app.alerts set resolved_at = now() where clinic_id = $1 and kind = 'whatsapp_fora'`,
      [clinicaA],
    );
    const a = (await operador.saudeDasClinicas(db)).find((s) => s.clinicId === clinicaA);
    expect(a?.whatsappForaDesde).toBeNull();
  });

  it('clínica de demonstração fica fora: agenda fabricada não acorda ninguém', async () => {
    const demo = await criarClinica('Clínica Demo', { demo: true });
    const saudes = await operador.saudeDasClinicas(db);
    expect(saudes.map((s) => s.clinicId)).not.toContain(demo);
  });

  it('clínica desativada fica fora', async () => {
    const morta = await criarClinica('Clínica Encerrada');
    await owner.query('update app.clinics set active = false where id = $1', [morta]);
    const saudes = await operador.saudeDasClinicas(db);
    expect(saudes.map((s) => s.clinicId)).not.toContain(morta);
  });
});

describe('a tabela do reenvio obedece a RLS como todas as outras', () => {
  it('tem RLS ligada, forçada, e política de tenant', async () => {
    const { rows } = await owner.query<{
      rls: boolean;
      force: boolean;
      politicas: string;
    }>(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as force,
              (select count(*) from pg_policy p where p.polrelid = c.oid)::text as politicas
         from pg_class c
        where c.relname = 'operator_notices' and c.relnamespace = 'app'::regnamespace`,
    );
    // Forçada, sem exceção: a leitura cruzada é da função definer, a escrita é por clínica.
    expect(rows[0]?.rls).toBe(true);
    expect(rows[0]?.force).toBe(true);
    expect(rows[0]?.politicas).toBe('1');
  });

  it('a clínica A não vê o aviso da clínica B', async () => {
    await withClinic(
      clinicaA,
      (trx) => operador.registrarEnvio(trx, clinicaA, 'silencio', new Date()),
      db,
    );
    await withClinic(
      clinicaB,
      (trx) => operador.registrarEnvio(trx, clinicaB, 'whatsapp_fora', new Date()),
      db,
    );

    const daA = await withClinic(clinicaA, (trx) => operador.avisosDaClinica(trx), db);
    const daB = await withClinic(clinicaB, (trx) => operador.avisosDaClinica(trx), db);

    expect([...daA.keys()]).toEqual(['silencio']);
    expect([...daB.keys()]).toEqual(['whatsapp_fora']);
  });

  it('reenvio soma e não reescreve a idade do problema', async () => {
    const primeiro = new Date(Date.now() - 3 * 3_600_000);
    const segundo = new Date();
    await withClinic(
      clinicaA,
      async (trx) => {
        await operador.esquecerCausas(trx, clinicaA, ['qualidade']);
        await operador.registrarEnvio(trx, clinicaA, 'qualidade', primeiro);
        await operador.registrarEnvio(trx, clinicaA, 'qualidade', segundo);
      },
      db,
    );

    const avisos = await withClinic(clinicaA, (trx) => operador.avisosDaClinica(trx), db);
    const q = avisos.get('qualidade');
    expect(q?.envios).toBe(2);
    // `first_seen_at` é a idade do problema: sobrescrevê-lo faria uma queda de três horas
    // parecer recém-chegada a cada e-mail.
    expect(q?.vistoPrimeiroEm.getTime()).toBe(primeiro.getTime());
    expect(q?.ultimoEnvioEm.getTime()).toBe(segundo.getTime());
  });

  it('esquecer apaga e rearma o teto', async () => {
    const apagadas = await withClinic(
      clinicaA,
      (trx) => operador.esquecerCausas(trx, clinicaA, ['qualidade', 'silencio']),
      db,
    );
    expect(apagadas).toBe(2);
    const avisos = await withClinic(clinicaA, (trx) => operador.avisosDaClinica(trx), db);
    expect(avisos.size).toBe(0);
  });

  it('causa que não está na lista do core é recusada pelo banco', async () => {
    // O `check` da 0015 e CAUSAS_DE_OPERADOR são a mesma lista. Causa nova sem passar pelos
    // dois lados não tem teto, não tem intervalo e não tem nome na coluna.
    await expect(
      owner.query(
        `insert into app.operator_notices (clinic_id, cause) values ($1, 'causa_inventada')`,
        [clinicaA],
      ),
    ).rejects.toThrow(/operator_notices_cause_check/);
  });
});
