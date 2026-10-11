import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarDb, type Db } from '../src/conexao';
import { envios } from '../src/index';
import { withClinic } from '../src/withClinic';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from './helpers';

/**
 * A trava de envio (0017): a mesma mensagem não sai duas vezes para a mesma consulta.
 *
 * O desenho é o do `no_double_booking`: quem decide é o banco. A reserva é feita ANTES de
 * chamar a Meta; a segunda tentativa bate 23505 e é "já saiu". Estes testes rodam como
 * `fliqo_app`, dentro de `withClinic`, como o worker.
 */

const TEMPLATE = 'confirmacao_consulta';

let owner: pg.Pool;
let db: Db;
let c: Scenario;
let consulta: string;
let inicio: Date;
let acao: string;

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  db = criarDb(urlDoTester());
}, 90_000);

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

beforeEach(async () => {
  await owner.query('delete from app.envios');
  await owner.query('delete from app.scheduled_actions');
  await owner.query('delete from app.appointments');
  const r = await owner.query<{ id: string; starts_at: Date }>(
    `insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
     values ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day 1 hour', 25000)
     returning id, starts_at`,
    [c.clinicA, c.profA, c.patients[0], c.procEletivo],
  );
  consulta = r.rows[0]?.id ?? '';
  inicio = r.rows[0]?.starts_at ?? new Date(0);
  const a = await owner.query<{ id: string }>(
    `insert into app.scheduled_actions (clinic_id, kind, appointment_id, due_at)
     values ($1, 'confirmacao', $2, now()) returning id`,
    [c.clinicA, consulta],
  );
  acao = a.rows[0]?.id ?? '';
});

function pedido(template = TEMPLATE, inicioDaConsulta = inicio) {
  return { clinicId: c.clinicA, appointmentId: consulta, inicioDaConsulta, template, acaoId: acao };
}

/** Reserva, "envia" e conclui numa transação só — o caminho feliz do worker. */
async function enviarComTrava(
  template = TEMPLATE,
  inicioDaConsulta = inicio,
): Promise<'enviou' | 'ja_saiu'> {
  return withClinic(
    c.clinicA,
    async (trx) => {
      const r = await envios.reservar(trx, pedido(template, inicioDaConsulta));
      if (!r.ok) return 'ja_saiu';
      await envios.concluir(trx, r.id, `wamid.${template}`);
      return 'enviou';
    },
    db,
  );
}

/** Uma promessa que o teste resolve na mão, para segurar uma transação aberta. */
function represa(): { promessa: Promise<void>; liberar: () => void } {
  let liberar = (): void => undefined;
  const promessa = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  return { promessa, liberar };
}

/** Resolve com 'pendente' se `p` não terminar em `ms`: é como se prova que alguém ESPERA. */
function aindaPendente<T>(p: Promise<T>, ms: number): Promise<T | 'pendente'> {
  return Promise.race([
    p,
    new Promise<'pendente'>((resolve) => setTimeout(() => resolve('pendente'), ms)),
  ]);
}

describe('a segunda tentativa não envia', () => {
  it('envio concluído e confirmado: a próxima reserva da mesma mensagem é "já saiu"', async () => {
    expect(await enviarComTrava()).toBe('enviou');
    expect(await enviarComTrava()).toBe('ja_saiu');
  });

  it('a linha guarda o wamid e o momento', async () => {
    await enviarComTrava();
    const { rows } = await owner.query<{ wamid: string; enviado_em: Date | null }>(
      'select wamid, enviado_em from app.envios',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.wamid).toBe(`wamid.${TEMPLATE}`);
    expect(rows[0]?.enviado_em).toBeInstanceOf(Date);
  });

  it('o "já saiu" não estraga a transação: a ação ainda pode ser marcada como feita', async () => {
    await enviarComTrava();
    // Sem o savepoint, o 23505 abortaria a transação e o update abaixo falharia com 25P02.
    await withClinic(
      c.clinicA,
      async (trx) => {
        expect((await envios.reservar(trx, pedido())).ok).toBe(false);
        await trx
          .updateTable('app.scheduled_actions')
          .set({ status: 'feito' })
          .where('id', '=', acao)
          .execute();
      },
      db,
    );
    const { rows } = await owner.query<{ status: string }>(
      'select status from app.scheduled_actions where id = $1',
      [acao],
    );
    expect(rows[0]?.status).toBe('feito');
  });

  it('a MESMA consulta movida para outro horário: a confirmação do horário novo sai', async () => {
    /*
     * Hoje remarcar cancela e cria outra consulta, então isto não acontece. A chave inclui o
     * horário para o dia em que algo mover a consulta no lugar: sem isso, a confirmação do
     * horário novo bateria numa trava que ninguém lembraria que existe.
     */
    expect(await enviarComTrava()).toBe('enviou');
    const novoHorario = new Date(inicio.getTime() + 2 * 60 * 60_000);
    await owner.query(
      `update app.appointments set starts_at = $2, ends_at = $2::timestamptz + interval '1 hour'
        where id = $1`,
      [consulta, novoHorario],
    );
    expect(await enviarComTrava(TEMPLATE, novoHorario)).toBe('enviou');
    // E o horário antigo continua travado: quem voltar com ele não manda de novo.
    expect(await enviarComTrava(TEMPLATE, inicio)).toBe('ja_saiu');
  });

  it('outro template para a mesma consulta é outra mensagem: confirmação e lembrete saem', async () => {
    expect(await enviarComTrava('confirmacao_consulta')).toBe('enviou');
    expect(await enviarComTrava('lembrete_final')).toBe('enviou');
  });
});

describe('dois workers com a mesma ação ao mesmo tempo', () => {
  it('o segundo ESPERA o primeiro, e quando ele confirma, o segundo não envia', async () => {
    const reservou = represa();
    const segurar = represa();

    const primeiro = withClinic(
      c.clinicA,
      async (trx) => {
        const r = await envios.reservar(trx, pedido());
        reservou.liberar();
        // Aqui o worker estaria chamando a Meta, com a reserva aberta.
        await segurar.promessa;
        if (r.ok) await envios.concluir(trx, r.id, 'wamid.PRIMEIRO');
        return r.ok;
      },
      db,
    );
    await reservou.promessa;

    const segundo = withClinic(c.clinicA, (trx) => envios.reservar(trx, pedido()), db);
    try {
      // Se a trava só olhasse envio concluído, o segundo reservaria agora e chamaria a Meta
      // em paralelo. Ele tem de estar parado no índice, esperando o primeiro decidir.
      expect(await aindaPendente(segundo, 300)).toBe('pendente');
    } finally {
      // Solta o primeiro mesmo se a afirmação cair: transação presa derrubaria os seguintes.
      segurar.liberar();
    }
    expect(await primeiro).toBe(true);
    expect(await segundo).toEqual({ ok: false, motivo: 'ja_saiu' });
  });

  it('se o primeiro cai antes do commit, o segundo envia: é a janela aceita', async () => {
    /*
     * "Pelo menos uma vez", escrito: o primeiro pode ter recebido o 200 da Meta e caído
     * antes do commit. A reserva volta junto com a transação, e o segundo envia de novo.
     * Só a Meta sabe que a mensagem saiu.
     */
    const reservou = represa();
    const cair = represa();

    const primeiro = withClinic(
      c.clinicA,
      async (trx) => {
        await envios.reservar(trx, pedido());
        reservou.liberar();
        await cair.promessa;
        throw new Error('worker caiu entre o 200 da Meta e o commit');
      },
      db,
    );
    await reservou.promessa;
    const segundo = enviarComTrava();

    cair.liberar();
    await expect(primeiro).rejects.toThrow('worker caiu');
    expect(await segundo).toBe('enviou');
  });
});

describe('reserva que não foi concluída nem desfeita não fica', () => {
  it('o commit é recusado: reserva esquecida não pode virar trava eterna', async () => {
    // Uma reserva sem wamid gravada para sempre seria a confirmação que nunca mais sai.
    await expect(
      withClinic(c.clinicA, (trx) => envios.reservar(trx, pedido()), db),
    ).rejects.toThrow(/sem wamid/);
    const { rows } = await owner.query('select 1 from app.envios');
    expect(rows).toHaveLength(0);
  });

  it('desfeita, a reserva some, e a próxima tentativa envia', async () => {
    await withClinic(
      c.clinicA,
      async (trx) => {
        const r = await envios.reservar(trx, pedido());
        if (r.ok) await envios.desfazer(trx, r.id);
      },
      db,
    );
    expect(await enviarComTrava()).toBe('enviou');
  });

  it('wamid sem momento, ou momento sem wamid, o banco recusa', async () => {
    await expect(
      owner.query(
        `insert into app.envios
           (clinic_id, appointment_id, appointment_starts_at, template_name, wamid)
         values ($1, $2, $3, $4, 'wamid.X')`,
        [c.clinicA, consulta, inicio, TEMPLATE],
      ),
    ).rejects.toThrow(/envio_wamid_e_momento_juntos/);
  });
});

describe('a trava é por clínica', () => {
  it('a clínica B não enxerga os envios da A', async () => {
    await enviarComTrava();
    const vistos = await withClinic(
      c.clinicB,
      (trx) => trx.selectFrom('app.envios').selectAll().execute(),
      db,
    );
    expect(vistos).toEqual([]);
  });
});
