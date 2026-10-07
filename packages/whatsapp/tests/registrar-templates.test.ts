import { describe, expect, it } from 'vitest';
import {
  lerAmbiente,
  linhaDoVeredito,
  listarExistentes,
  registrarTodos,
  type TemplateNaMeta,
} from '../scripts/registrar-templates';
import { todasAsDefinicoes } from '../src/templates';

const CFG = {
  WHATSAPP_WABA_ID: 'waba-de-teste',
  WHATSAPP_TOKEN: 'token-falso-de-teste',
  META_GRAPH_BASE: 'https://graph.exemplo.invalido',
  META_GRAPH_VERSION: 'v21.0',
};

interface Chamada {
  url: string;
  metodo: string;
  corpo: unknown;
}

/**
 * Um Graph API falso. A lista responde o que o teste mandar; o POST registra a chamada.
 *
 * Nenhum teste aqui toca a rede: a base é um domínio `.invalido`, que por RFC 2606 nunca
 * resolve — se algum caminho escapar do `fetch` falso, o teste falha em vez de criar
 * template de verdade na conta de alguém.
 */
function graphFalso(
  jaExistem: TemplateNaMeta[],
  respostaDoPost: (corpo: unknown) => Response = () => Response.json({ id: '1' }),
): { buscar: typeof fetch; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const buscar = ((url: string, init?: RequestInit) => {
    const metodo = init?.method ?? 'GET';
    const enviado = init?.body;
    const corpo = typeof enviado === 'string' ? JSON.parse(enviado) : undefined;
    chamadas.push({ url, metodo, corpo });
    if (metodo === 'GET') return Promise.resolve(Response.json({ data: jaExistem }));
    return Promise.resolve(respostaDoPost(corpo));
  }) as unknown as typeof fetch;
  return { buscar, chamadas };
}

function comoExistente(nome: string, status = 'APPROVED'): TemplateNaMeta {
  return { name: nome, language: 'pt_BR', status };
}

describe('o ambiente do script', () => {
  it('exige as duas variáveis e diz onde achar cada uma', () => {
    expect(() => lerAmbiente({})).toThrow(/WHATSAPP_WABA_ID/);
    expect(() => lerAmbiente({ WHATSAPP_WABA_ID: 'x' })).toThrow(/WHATSAPP_TOKEN/);
    expect(() => lerAmbiente({})).toThrow(/whatsapp_business_management/);
  });

  it('a base e a versão do Graph têm padrão: só as credenciais são obrigatórias', () => {
    const cfg = lerAmbiente({ WHATSAPP_WABA_ID: 'w', WHATSAPP_TOKEN: 't' });
    expect(cfg.META_GRAPH_BASE).toBe('https://graph.facebook.com');
    expect(cfg.META_GRAPH_VERSION).toBe('v21.0');
  });

  it('a mensagem de erro diz o NOME da variável e nunca o valor', () => {
    // As duas metades importam: sem o nome, quem rodou não sabe o que faltou; com o valor,
    // o token vai para o histórico do terminal e para o log de quem rodou.
    const valor = 'EAAG-valor-que-nao-pode-vazar';
    try {
      lerAmbiente({ WHATSAPP_TOKEN: valor });
      expect.unreachable('devia ter falhado por falta do WABA');
    } catch (erro) {
      expect(String(erro)).toContain('WHATSAPP_WABA_ID');
      expect(String(erro)).not.toContain(valor);
    }
  });
});

describe('a leitura do que já existe', () => {
  it('segue a paginação da Meta', async () => {
    // Sem seguir o `next`, o script tentaria recriar o que está na segunda página.
    let pagina = 0;
    const buscar = (() => {
      pagina++;
      return Promise.resolve(
        pagina === 1
          ? Response.json({
              data: [comoExistente('fliqo_remarcacao')],
              paging: { next: `${CFG.META_GRAPH_BASE}/pagina2` },
            })
          : Response.json({ data: [comoExistente('aviso_de_atraso')] }),
      );
    }) as unknown as typeof fetch;

    const todos = await listarExistentes(CFG, buscar);
    expect(todos.map((t) => t.name)).toEqual(['fliqo_remarcacao', 'aviso_de_atraso']);
  });

  it('erro na leitura estoura em vez de fingir que a conta está vazia', async () => {
    // Fingir vazio faria o script submeter tudo de novo e colecionar recusas.
    const buscar = (() =>
      Promise.resolve(
        Response.json({ error: { message: 'Invalid OAuth access token' } }, { status: 401 }),
      )) as unknown as typeof fetch;
    await expect(listarExistentes(CFG, buscar)).rejects.toThrow(/Invalid OAuth access token/);
  });
});

describe('o registro é idempotente', () => {
  it('conta vazia: submete os sete, uma vez cada', async () => {
    const { buscar, chamadas } = graphFalso([]);
    const vereditos = await registrarTodos(CFG, buscar);

    expect(vereditos.every((v) => v.situacao === 'criado')).toBe(true);
    const posts = chamadas.filter((c) => c.metodo === 'POST');
    expect(posts).toHaveLength(todasAsDefinicoes().length);
    expect(posts.map((p) => (p.corpo as { name: string }).name)).toEqual(
      todasAsDefinicoes().map((d) => d.nome),
    );
  });

  it('rodar de novo com tudo registrado não manda POST nenhum', async () => {
    const { buscar, chamadas } = graphFalso(todasAsDefinicoes().map((d) => comoExistente(d.nome)));
    const vereditos = await registrarTodos(CFG, buscar);

    expect(chamadas.filter((c) => c.metodo === 'POST')).toHaveLength(0);
    expect(vereditos.every((v) => v.situacao === 'ja_existe')).toBe(true);
  });

  it('submete só o que falta, e não mexe no que já está lá', async () => {
    const { buscar, chamadas } = graphFalso([comoExistente('fliqo_remarcacao', 'PENDING')]);
    const vereditos = await registrarTodos(CFG, buscar);

    const posts = chamadas.filter((c) => c.metodo === 'POST');
    expect(posts.map((p) => (p.corpo as { name: string }).name)).not.toContain('fliqo_remarcacao');
    expect(posts).toHaveLength(todasAsDefinicoes().length - 1);
    expect(vereditos).toContainEqual({
      template: 'fliqo_remarcacao',
      situacao: 'ja_existe',
      status: 'PENDING',
    });
  });

  it('o mesmo nome em outro idioma não conta como registrado', async () => {
    // Template é identificado por (nome, idioma): o nosso é pt_BR e só pt_BR serve.
    const { buscar, chamadas } = graphFalso([
      { name: 'fliqo_remarcacao', language: 'en_US', status: 'APPROVED' },
    ]);
    await registrarTodos(CFG, buscar);
    const nomes = chamadas
      .filter((c) => c.metodo === 'POST')
      .map((p) => (p.corpo as { name: string }).name);
    expect(nomes).toContain('fliqo_remarcacao');
  });

  it('"already exists" vindo como erro do POST não quebra o script', async () => {
    // Acontece quando o template nasce entre a leitura e o POST. O resultado desejado
    // — o template existir — aconteceu, então falhar aqui seria falhar por nada.
    const { buscar } = graphFalso([], () =>
      Response.json(
        { error: { message: 'template name already exists', code: 100, error_subcode: 2388023 } },
        { status: 400 },
      ),
    );
    const vereditos = await registrarTodos(CFG, buscar);
    expect(vereditos.every((v) => v.situacao === 'ja_existe')).toBe(true);
  });

  it('erro de verdade no POST vira falha, com a frase da Meta', async () => {
    const { buscar } = graphFalso([], () =>
      Response.json(
        { error: { message: 'Application does not have permission for this action' } },
        { status: 403 },
      ),
    );
    const vereditos = await registrarTodos(CFG, buscar);
    expect(vereditos[0]).toEqual({
      template: 'fliqo_confirmacao_consulta',
      situacao: 'falhou',
      detalhe: 'Application does not have permission for this action',
    });
  });

  it('o POST manda o corpo com {{1}}, não com o nome do parâmetro', async () => {
    const { buscar, chamadas } = graphFalso([]);
    await registrarTodos(CFG, buscar);
    const corpo = JSON.stringify(chamadas.find((c) => c.metodo === 'POST')?.corpo);
    expect(corpo).toContain('{{1}}');
    expect(corpo).not.toContain('{{nome_paciente}}');
  });

  it('nenhuma chamada leva o token na URL', async () => {
    // Token em query string vai para log de servidor e para histórico de proxy.
    const { buscar, chamadas } = graphFalso([]);
    await registrarTodos(CFG, buscar);
    for (const c of chamadas) expect(c.url).not.toContain(CFG.WHATSAPP_TOKEN);
  });
});

describe('catálogo inválido não é submetido', () => {
  const quebrado = {
    nome: 'fliqo_quebrado',
    categoria: 'UTILITY',
    idioma: 'pt_BR',
    parametros: ['a'],
    corpo: '{{a}} abre o corpo, e a Meta recusa isso.',
    exemplos: { a: 'Maria' },
    botoes: [],
  } as const;

  it('estoura antes do primeiro POST, dizendo qual template e qual problema', async () => {
    // A ordem importa: submissão recusada se corrige em minutos, submissão APROVADA com
    // corpo que o código não consegue preencher custa dois ciclos de revisão da Meta.
    const { buscar, chamadas } = graphFalso([]);
    await expect(registrarTodos(CFG, buscar, [quebrado])).rejects.toThrow(
      /fliqo_quebrado: parametro_abre_o_corpo/,
    );
    expect(chamadas.filter((c) => c.metodo === 'POST')).toHaveLength(0);
  });

  it('um template inválido impede a submissão dos válidos também', async () => {
    const { buscar, chamadas } = graphFalso([]);
    await expect(registrarTodos(CFG, buscar, [...todasAsDefinicoes(), quebrado])).rejects.toThrow(
      /nada foi submetido/,
    );
    expect(chamadas).toHaveLength(0);
  });
});

describe('a linha que o terminal mostra', () => {
  it('diz o status da Meta no que já existe', () => {
    expect(linhaDoVeredito({ template: 'x', situacao: 'ja_existe', status: 'REJECTED' })).toContain(
      'REJECTED',
    );
  });

  it('diz que o criado está esperando revisão', () => {
    expect(linhaDoVeredito({ template: 'x', situacao: 'criado' })).toContain('aguardando revisão');
  });

  it('a falha aparece em maiúscula para não passar batida numa lista de sete', () => {
    expect(linhaDoVeredito({ template: 'x', situacao: 'falhou', detalhe: 'y' })).toContain(
      'FALHOU',
    );
  });
});
