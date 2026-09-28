#!/usr/bin/env node
/**
 * Confere se as funções `security definer` conseguem MESMO ler o que precisam.
 *
 * O problema que isto pega, e que não falha em lugar nenhum quando acontece:
 * uma função `security definer` roda com os poderes do DONO dela. Se a tabela
 * que ela lê tem `force row level security`, a política vale também para o dono
 * — e a função, que existe justamente para cruzar clínicas antes de haver
 * clínica na transação, passa a devolver zero linha. Nada estoura. A varredura
 * de atrasos simplesmente para de avisar paciente, e ninguém percebe.
 *
 * Aqui isso funciona porque o `postgres` local é superusuário, e superusuário
 * ignora RLS com `force` ou sem. No Supabase o `postgres` NÃO é superusuário
 * (foi o que descobrimos ao tirar NOSUPERUSER do papel-app). Então o lugar de
 * conferir é o workflow de migração, contra o banco de verdade.
 *
 * Esta conferência não corrige nada: ela falha alto, nomeando a função, a
 * tabela e o papel. A correção fica para uma migração revisada — política
 * explícita liberando o papel dono, que fica visível no schema e tem escopo por
 * tabela, e não BYPASSRLS, que é interruptor global e some da vista.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { adminUrlDoAmbiente } from './pooler.mjs';
import { falhar } from './segredos.mjs';

/** As tabelas de `app` que o corpo da função cita como `app.<tabela>`. */
export function tabelasReferenciadas(prosrc, tabelasDeApp) {
  const achadas = new Set();
  for (const [, nome] of String(prosrc).matchAll(/\bapp\.([a-z_][a-z0-9_]*)/gi)) {
    const minusculo = nome.toLowerCase();
    if (tabelasDeApp.includes(minusculo)) achadas.add(minusculo);
  }
  return [...achadas].sort();
}

/**
 * Referências a `app.<algo>` que a conferência NÃO sabe conferir.
 *
 * O parser só confere tabela de verdade. Uma função que leia uma view, ou uma
 * tabela que não existe mais, seria pulada em silêncio — e pular em silêncio é
 * exatamente o falso verde que esta conferência existe para impedir. Então o
 * que não for tabela nem função conhecida do schema é acusado pelo nome.
 */
export function referenciasNaoConferidas(prosrc, tabelasDeApp, funcoesDeApp) {
  const conhecidas = new Set([...tabelasDeApp, ...funcoesDeApp]);
  const fora = new Set();
  for (const [, nome] of String(prosrc).matchAll(/\bapp\.([a-z_][a-z0-9_]*)/gi)) {
    const minusculo = nome.toLowerCase();
    if (!conhecidas.has(minusculo)) fora.add(minusculo);
  }
  return [...fora].sort();
}

/**
 * Os comandos que a função precisa poder executar naquela tabela.
 *
 * Ler é sempre necessário. Escrever, só quando o corpo escreve — e é aqui que
 * mora a armadilha: `claim_due_actions` e `requeue_stuck_actions` fazem UPDATE.
 * Uma política `for select` nessas tabelas faria a acusação desaparecer daqui e
 * a fila continuar travada em produção, que é exatamente o modo de falha
 * silenciosa que esta conferência existe para caçar.
 */
export function comandosNecessarios(prosrc, tabela) {
  const texto = String(prosrc);
  const precisa = new Set(['select']);
  const escritas = [
    ['update', new RegExp(`\\bupdate\\s+app\\.${tabela}\\b`, 'i')],
    ['insert', new RegExp(`\\binsert\\s+into\\s+app\\.${tabela}\\b`, 'i')],
    ['delete', new RegExp(`\\bdelete\\s+from\\s+app\\.${tabela}\\b`, 'i')],
  ];
  for (const [comando, padrao] of escritas) if (padrao.test(texto)) precisa.add(comando);
  return [...precisa].sort();
}

/** Letra de `pg_policy.polcmd` para o nome do comando. `*` é ALL. */
const COMANDO_DA_POLITICA = { r: 'select', a: 'insert', w: 'update', d: 'delete' };

/** Os comandos que uma política cobre. */
export function comandosDaPolitica(polcmd) {
  if (polcmd === '*') return ['select', 'insert', 'update', 'delete'];
  const nome = COMANDO_DA_POLITICA[polcmd];
  return nome === undefined ? [] : [nome];
}

/**
 * Tabela conhecida citada SEM o `app.` na frente.
 *
 * O parser acima só enxerga referência qualificada. Uma função que confia no
 * `search_path` e escreve `from appointments` passaria batida — então em vez de
 * adivinhar (e arriscar confundir apelido com tabela), esta conferência acusa e
 * pede para qualificar. Guarda do próprio parser.
 */
export function referenciasSemEsquema(prosrc, tabelasDeApp) {
  const texto = String(prosrc);
  const semQualificar = new Set();
  for (const tabela of tabelasDeApp) {
    // (^|não-precedido-por ponto ou letra) nome (seguido de não-letra)
    const solta = new RegExp(`(^|[^.\\w])${tabela}\\b`, 'i');
    const qualificada = new RegExp(`\\bapp\\.${tabela}\\b`, 'i');
    const semPrefixo = texto.replace(new RegExp(`\\bapp\\.${tabela}\\b`, 'gi'), ' ');
    if (solta.test(semPrefixo) && !qualificada.test(semPrefixo)) semQualificar.add(tabela);
  }
  return [...semQualificar].sort();
}

/**
 * O veredito de um par (função, tabela).
 *
 * A ordem das saídas importa: `row_security_active` é a palavra do próprio
 * Postgres e vale mais do que qualquer leitura de atributo que a gente faça.
 */
export function veredito(caso) {
  const onde = `${caso.funcao}() lendo app.${caso.tabela} como ${caso.dono}`;

  if (caso.donoEhSuperusuario) return { ok: true, porque: 'o dono é superusuário e ignora a RLS' };
  if (caso.donoTemBypassRls) return { ok: true, porque: 'o dono tem BYPASSRLS' };
  if (caso.rlsAtivaParaODono === false) {
    return { ok: true, porque: 'o Postgres confirma que a RLS não se aplica ao dono aqui' };
  }
  const cobertos = new Set(caso.politicasQueNomeiamODono.flatMap((p) => p.comandos));
  const descobertos = caso.comandosNecessarios.filter((c) => !cobertos.has(c));

  if (caso.politicasQueNomeiamODono.length > 0 && descobertos.length === 0) {
    const nomes = caso.politicasQueNomeiamODono.map((p) => p.nome).join(', ');
    return {
      ok: true,
      porque: `a política ${nomes} nomeia o papel e cobre ${caso.comandosNecessarios.join(' e ')}`,
    };
  }

  // Política que nomeia o papel mas cobre menos do que a função faz é pior do
  // que política nenhuma: ela silencia a acusação sem destravar a operação.
  if (caso.politicasQueNomeiamODono.length > 0) {
    const nomes = caso.politicasQueNomeiamODono.map((p) => p.nome).join(', ');
    return {
      ok: false,
      mensagem:
        `${onde}: a política ${nomes} nomeia o papel mas não cobre ${descobertos.join(' e ')}. ` +
        `A função precisa de ${caso.comandosNecessarios.join(' e ')} nesta tabela. ` +
        `Conserto: política \`for all\` em app.${caso.tabela} liberando ${caso.dono}.`,
    };
  }

  if (caso.rlsAtivaParaODono === true || caso.rlsForcada) {
    return {
      ok: false,
      mensagem:
        `${onde}: a RLS se aplica ao dono e nenhuma política o alcança. ` +
        `A função devolve zero linha e nada estoura. ` +
        `Conserto: política explícita ${caso.comandosNecessarios.length > 1 ? '`for all`' : '`for select`'} ` +
        `em app.${caso.tabela} liberando ${caso.dono} (precisa de ${caso.comandosNecessarios.join(' e ')}).`,
    };
  }

  if (caso.rlsAtivaParaODono === undefined) {
    return {
      ok: false,
      mensagem:
        `${onde}: não deu para assumir o papel do dono nem provar que ele lê a tabela. ` +
        `Rode a conferência com um papel que seja membro de ${caso.dono}.`,
    };
  }

  return { ok: true, porque: 'a tabela não força RLS e o dono não está preso à política' };
}

/** Uma política é "explícita" quando nomeia papéis; `to public` não libera ninguém. */
const PUBLICO = '0';

export async function conferir(cliente) {
  const { rows: tabelas } = await cliente.query(
    `select c.relname as nome, c.relforcerowsecurity as forcada, c.relowner as dono_oid
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relkind = 'r'`,
  );
  const nomesDeTabela = tabelas.map((t) => t.nome);
  const porTabela = new Map(tabelas.map((t) => [t.nome, t]));

  const { rows: nomesDeFuncao } = await cliente.query(
    `select distinct p.proname as nome
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'`,
  );
  const funcoesDeApp = nomesDeFuncao.map((f) => f.nome);

  const { rows: funcoes } = await cliente.query(
    `select p.proname as nome, p.prosrc as corpo, p.proowner as dono_oid,
            r.rolname as dono, r.rolsuper as super, r.rolbypassrls as bypassrls
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_roles r on r.oid = p.proowner
      where n.nspname = 'app' and p.prosecdef
      order by p.proname`,
  );

  const { rows: politicas } = await cliente.query(
    `select c.relname as tabela, p.polname as nome, p.polpermissive as permissiva,
            p.polcmd as comando, p.polroles::oid[] as papeis
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app'`,
  );

  const {
    rows: [{ atual }],
  } = await cliente.query(`select current_user as atual`);

  const linhas = [];
  const falhas = [];
  const naoQualificadas = [];
  const naoConferidas = [];

  for (const f of funcoes) {
    const semEsquema = referenciasSemEsquema(f.corpo, nomesDeTabela);
    for (const t of semEsquema) naoQualificadas.push(`${f.nome}() cita ${t} sem o prefixo app.`);

    for (const alvo of referenciasNaoConferidas(f.corpo, nomesDeTabela, funcoesDeApp)) {
      naoConferidas.push(
        `${f.nome}() lê app.${alvo}, que não é tabela nem função deste schema ` +
          `(view? tabela que sumiu?). A conferência não sabe dizer se o dono alcança.`,
      );
    }

    for (const nome of tabelasReferenciadas(f.corpo, nomesDeTabela)) {
      const tabela = porTabela.get(nome);
      const rlsAtivaParaODono = await rlsAtivaPara(cliente, f.dono, atual, nome);
      const politicasQueNomeiamODono = politicas
        .filter((p) => p.tabela === nome && p.permissiva)
        .filter((p) =>
          (p.papeis ?? []).some(
            (oid) => String(oid) !== PUBLICO && String(oid) === String(f.dono_oid),
          ),
        )
        .map((p) => ({ nome: p.nome, comandos: comandosDaPolitica(p.comando) }));

      const caso = {
        funcao: f.nome,
        tabela: nome,
        dono: f.dono,
        rlsForcada: tabela.forcada,
        donoEhSuperusuario: f.super,
        donoTemBypassRls: f.bypassrls,
        rlsAtivaParaODono,
        politicasQueNomeiamODono,
        comandosNecessarios: comandosNecessarios(f.corpo, nome),
      };
      const v = veredito(caso);
      linhas.push({ ...caso, ...v });
      if (!v.ok) falhas.push(v.mensagem);
    }
  }

  return { linhas, falhas, naoQualificadas, naoConferidas, usuarioAtual: atual };
}

/**
 * `row_security_active` é o Postgres respondendo "a RLS vale para mim nesta
 * tabela?". Vale mais do que deduzir de atributo. Precisa rodar COMO o dono:
 * se não der para assumir o papel, devolve undefined em vez de chutar.
 */
async function rlsAtivaPara(cliente, dono, usuarioAtual, tabela) {
  if (dono === usuarioAtual) {
    const { rows } = await cliente.query(`select row_security_active($1) as ativa`, [
      `app.${tabela}`,
    ]);
    return rows[0].ativa;
  }
  try {
    await cliente.query('begin');
    await cliente.query(`set local role ${cliente.escapeIdentifier(dono)}`);
    const { rows } = await cliente.query(`select row_security_active($1) as ativa`, [
      `app.${tabela}`,
    ]);
    await cliente.query('rollback');
    return rows[0].ativa;
  } catch {
    // Não é membro do papel do dono: não dá para provar nada assumindo ele.
    await cliente.query('rollback');
    return undefined;
  }
}

export function relatorio({ linhas, falhas, naoQualificadas, naoConferidas, usuarioAtual }) {
  const saida = [`conferência rodada como ${usuarioAtual}`, ''];
  for (const l of linhas) {
    const marca = l.ok ? 'ok  ' : 'FALHA';
    const detalhe = l.ok ? l.porque : 'a RLS bloqueia';
    saida.push(
      `${marca} ${l.funcao}() -> app.${l.tabela} (${l.comandosNecessarios.join('+')})  ` +
        `[dono ${l.dono}, force ${String(l.rlsForcada)}, super ${String(l.donoEhSuperusuario)}, ` +
        `bypassrls ${String(l.donoTemBypassRls)}] ${detalhe}`,
    );
  }
  if (naoQualificadas.length > 0) {
    saida.push('', 'referências sem o prefixo app. (o parser não as enxerga):');
    for (const n of naoQualificadas) saida.push(`  ${n}`);
  }
  if (naoConferidas.length > 0) {
    saida.push('', 'referências que a conferência não sabe conferir:');
    for (const n of naoConferidas) saida.push(`  ${n}`);
  }
  if (falhas.length > 0) {
    saida.push('', 'as funções abaixo não conseguem ler o que precisam:');
    for (const f of falhas) saida.push(`  ${f}`);
  }
  return saida.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Silencioso de propósito: esta conferência conta papel, função, tabela e
  // veredito, e mais nada. Nem host, nem porta, nem usuário — e a string de
  // conexão não sai daqui em hipótese alguma, nem dentro de erro (`falhar`).
  const url = await adminUrlDoAmbiente(process.env, { registrar: () => undefined });
  const cliente = new pg.Client({ connectionString: url });
  try {
    await cliente.connect();
    const r = await conferir(cliente);
    console.log(relatorio(r));
    if (r.falhas.length > 0 || r.naoQualificadas.length > 0 || r.naoConferidas.length > 0) {
      console.error(
        `::error::${r.falhas.length} função(ões) security definer sem acesso ao que leem, ` +
          `${r.naoQualificadas.length} referência(s) sem o prefixo app., ` +
          `${r.naoConferidas.length} referência(s) que a conferência não sabe conferir.`,
      );
      process.exit(1);
    }
  } catch (erro) {
    falhar(erro, [url]);
  } finally {
    await cliente.end();
  }
}
