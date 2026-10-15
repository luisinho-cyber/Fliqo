import { criarSinaisDeSaude, registrarLaco, servidorDeSaude } from '../src/saude';

/**
 * Processo à parte para o teste de saude.test.ts: o servidor de saúde REAL com um relógio
 * que lança dentro do handler. Precisa ser outro processo porque o que se prova é que o
 * PROCESSO não cai — dentro do vitest, a exceção não tratada seria segurada pelo próprio
 * vitest e o teste não veria a queda.
 *
 * A exceção é provocada no `/estado`, e não no `/health`: o `/health` não lê relógio,
 * batimento nem entrega, de propósito — ele responde 200 enquanto o processo vive. Quem
 * chama o relógio é o veredito.
 *
 * O token é falso, nasce aqui e sai no stdout porque quem pergunta é o processo pai.
 */
const TOKEN = 'token-falso-do-fixture-que-explode-00001';

const sinais = criarSinaisDeSaude();
registrarLaco(sinais, 'acoes');

const servidor = servidorDeSaude({
  porta: 0,
  sinais,
  tokenDoEstado: TOKEN,
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
    process.stdout.write(`TOKEN ${TOKEN}\nPORTA ${String(endereco.port)}\n`);
  }
});
