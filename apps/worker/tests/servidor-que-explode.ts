import { criarBatimento, servidorDeSaude } from '../src/saude';

/**
 * Processo à parte para o teste de saude.test.ts: o servidor de saúde REAL com um relógio
 * que lança dentro do handler. Precisa ser outro processo porque o que se prova é que o
 * PROCESSO não cai — dentro do vitest, a exceção não tratada seria segurada pelo próprio
 * vitest e o teste não veria a queda.
 */
const servidor = servidorDeSaude({
  porta: 0,
  batimentos: { acoes: criarBatimento() },
  agora: () => {
    throw new Error('explodiu dentro do handler');
  },
  aoFalhar: (erro) => {
    process.stdout.write(`FALHOU ${erro instanceof Error ? erro.message : 'desconhecido'}\n`);
  },
});

servidor.once('listening', () => {
  const endereco = servidor.address();
  if (endereco !== null && typeof endereco === 'object') {
    process.stdout.write(`PORTA ${String(endereco.port)}\n`);
  }
});
