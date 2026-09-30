import { Cabecalho } from '../../../componentes/Cabecalho';
import { Indisponivel, Vazio } from '../../../componentes/Avisos';
import { ConectarWhatsapp } from '../../../componentes/ConectarWhatsapp';
import { Qualidade } from '../../../componentes/Qualidade';
import { buscar, entrarNoPainel } from '../../../lib/painel';
import { diaEMes, lerQualidade } from '../../../lib/qualidade';
import { configDoSignup } from '../../../lib/signup';
import type { EventoDeConexao, StatusDoWhatsapp } from '../../../lib/tipos';
import { desconectarWhatsapp } from '../../acoes';

/**
 * O WhatsApp da clínica.
 *
 * Componente de servidor: quem tem o portador da sessão é o servidor do painel,
 * e é ele quem fala com a nossa API. O navegador recebe daqui dois
 * identificadores públicos do fluxo da Meta e nada mais — nenhum segredo, nenhum
 * token, nenhum endereço da Graph API.
 *
 * Só o perfil dono entra: conectar e desligar o número decide se a clínica fala
 * com os pacientes. A API nega igual, com 403; a tela não oferece o que ela vai
 * negar.
 */

export const dynamic = 'force-dynamic';

const SITUACOES: Record<string, string> = {
  conectado: 'Ligado',
  pendente: 'Ainda não ligado',
  erro: 'Com problema',
  desconectado: 'Desligado',
};

const EVENTOS: Record<EventoDeConexao['kind'], string> = {
  conectou: 'ligou o número',
  reconectou: 'religou o número',
  falhou: 'tentou ligar e não deu',
  desconectou: 'desligou o número',
};

export default async function WhatsappDaClinica() {
  const entrada = await entrarNoPainel();
  if (!entrada.ok) {
    return (
      <main className="mx-auto max-w-[720px] px-5 py-12">
        <Indisponivel oQue="a configuração do WhatsApp" />
      </main>
    );
  }
  const { ctx } = entrada;

  const cabecalho = (
    <Cabecalho atual="/configuracoes/whatsapp" clinica={ctx.clinica} clinicas={ctx.clinicas} />
  );

  if (ctx.clinica.papel !== 'dono') {
    return (
      <div className="flex min-h-screen flex-col">
        {cabecalho}
        <main className="flex-1 p-5">
          <Vazio
            titulo="Só quem é dono da clínica liga o WhatsApp."
            detalhe="Ligar ou desligar o número muda por onde a clínica fala com os pacientes. Peça a quem é dono aqui — se for você, avise quem cuida do sistema para ajustar seu perfil."
          />
        </main>
      </div>
    );
  }

  const r = await buscar<StatusDoWhatsapp>(ctx, '/api/whatsapp/status');
  const signup = configDoSignup();

  return (
    <div className="flex min-h-screen flex-col">
      {cabecalho}
      <main className="flex-1 p-5">
        <section className="bg-paper mx-auto max-w-[720px] rounded-lg p-5">
          <h1 className="mb-1 text-xl">WhatsApp da clínica</h1>
          <p className="text-ink-2 mb-5 max-w-[56ch] text-sm">
            Ligue o número que a clínica já usa. Vocês continuam atendendo pelo aplicativo no
            celular — quando alguém responde por lá, a atendente automática para de responder
            naquela conversa. As conversas antigas do aplicativo não são trazidas para cá.
          </p>

          {!r.ok ? (
            <Indisponivel oQue="a situação do número" />
          ) : (
            <>
              {r.dados.conexao === null ? (
                <Vazio
                  titulo="Nenhum número ligado ainda."
                  detalhe="Enquanto não houver número, a clínica não recebe nem envia mensagem pela Fliqo. Ligar leva um minuto e não tira o WhatsApp do celular de ninguém."
                />
              ) : (
                <Ficha status={r.dados} />
              )}

              <div className="border-fio-2 mt-5 border-t pt-5">
                {signup === undefined ? (
                  <Vazio
                    titulo="O ambiente ainda não está configurado para ligar números."
                    detalhe="Faltam as variáveis META_APP_ID e META_CONFIG_ID no serviço do painel. Isso é ajuste de quem cuida do sistema, não da clínica."
                  />
                ) : (
                  <ConectarWhatsapp
                    appId={signup.appId}
                    configId={signup.configId}
                    reconectar={r.dados.conexao !== null}
                  />
                )}
              </div>

              {r.dados.conexao !== null && r.dados.conexao.status !== 'desconectado' && (
                <form action={desconectarWhatsapp} className="border-fio-2 mt-5 border-t pt-5">
                  <p className="mb-2 max-w-[56ch] text-sm">
                    Desligar apaga o acesso que guardamos e a clínica para de receber e de enviar
                    mensagem pela Fliqo. O WhatsApp no celular continua funcionando como sempre.
                  </p>
                  <button
                    type="submit"
                    className="border-risco text-risco rounded-pill border px-4 py-2 text-[13px] font-semibold"
                  >
                    Desligar o número
                  </button>
                </form>
              )}

              <Historico eventos={r.dados.eventos} fuso={r.dados.fuso} />
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function Ficha({ status }: { status: StatusDoWhatsapp }) {
  const c = status.conexao;
  if (c === null) return null;
  const agora = Date.now();
  const nomeApurado =
    c.nomeVerificadoEm === null ? null : diaEMes(Date.parse(c.nomeVerificadoEm), status.fuso);

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2">
      <dt className="text-ink-2">Situação</dt>
      <dd className="m-0">{SITUACOES[c.status] ?? c.status}</dd>

      <dt className="text-ink-2">Número</dt>
      <dd className="m-0 tabular-nums">{c.telefoneExibicao ?? c.phoneNumberId}</dd>

      <dt className="text-ink-2">Nome verificado</dt>
      <dd className="m-0">
        {c.nomeVerificado === null ? (
          <span className="text-ink-2">a Meta ainda não informou</span>
        ) : (
          <>
            {c.nomeVerificado}
            {/* Data seca: nome desatualizado não causa dano, então não vira alarme. */}
            {nomeApurado !== null && (
              <span className="text-ink-2 text-[13px]"> · {nomeApurado}</span>
            )}
          </>
        )}
      </dd>

      <dt className="text-ink-2">Qualidade</dt>
      <dd className="m-0">
        <Qualidade leitura={lerQualidade(c.qualidade, c.qualidadeEm, agora, status.fuso)} />
      </dd>

      <dt className="text-ink-2">Ligado em</dt>
      <dd className="m-0 tabular-nums">
        {c.conectadoEm === null ? '—' : diaEMes(Date.parse(c.conectadoEm), status.fuso)}
      </dd>

      {c.ultimoErro !== null && (
        <>
          <dt className="text-ink-2">Último problema</dt>
          <dd className="text-risco m-0">{c.ultimoErro}</dd>
        </>
      )}
    </dl>
  );
}

function Historico({ eventos, fuso }: { eventos: EventoDeConexao[]; fuso: string }) {
  if (eventos.length === 0) return null;
  return (
    <div className="mt-5">
      <h2 className="mb-2 text-base">O que já aconteceu com este número</h2>
      <ul className="m-0 list-none p-0">
        {eventos.map((e) => (
          <li key={e.id} className="border-fio flex gap-3 border-t py-2 text-sm first:border-t-0">
            <span className="text-ink-2 tabular-nums">
              {diaEMes(Date.parse(e.created_at), fuso)}
            </span>
            <span>
              {EVENTOS[e.kind]}
              {/* O detalhe só aparece na falha: é lá que ele explica algo. Ele já
                  vem redigido pela API — texto da Meta pode trazer segredo dentro. */}
              {e.kind === 'falhou' && e.detail !== null && (
                <span className="text-ink-2"> — {e.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
