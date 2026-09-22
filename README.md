# Fliqo

CRM para clínicas: agenda que não perde horário, aviso de atraso ao paciente, atendente de IA no WhatsApp e financeiro ligado à agenda.

## Comece por aqui

1. `CLAUDE.md` — regras do projeto (o Claude Code lê isso automaticamente).
2. `docs/ARQUITETURA.md` — como o sistema funciona e por quê.
3. `docs/ROTEIRO-CLAUDE-CODE.md` — as fases, com o prompt de cada uma.

## Rodar os testes

```bash
npm install
docker compose up -d
export DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres
npm test            # 63 testes: banco, regras de negócio e IA
npm run typecheck
```

## O que já existe

| Pacote          | Conteúdo                                                                                                                                                                                                | Testes                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `packages/db`   | Schema completo: RLS por clínica, anti-conflito de horário, régua de confirmação automática, lista de espera com aceite atômico, financeiro, horários reais de atendimento, duração real e pontualidade | 20 (Postgres real, incluindo concorrência) |
| `packages/core` | Dinheiro em centavos, markup divisor, lançamentos e projeção de caixa, horários livres, regras da fila, ritmo humano de resposta, previsão e aviso de atrasos                                           | 31                                         |
| `packages/ai`   | Perfil da clínica (versionado), prompt, ferramentas tipadas, proteções de entrada e saída                                                                                                               | 12                                         |

`apps/api`, `apps/worker` e `apps/web` são construídos seguindo o roteiro.
