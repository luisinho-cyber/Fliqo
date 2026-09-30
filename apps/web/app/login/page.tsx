import { entrar } from '../acoes';
import { Marca } from '../../componentes/Marca';

const MENSAGENS: Record<string, string> = {
  credenciais: 'E-mail ou senha não conferem. Tente de novo.',
  faltou: 'Preencha o e-mail e a senha.',
  sessao: 'Sua sessão terminou. Entre de novo para continuar.',
};

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const codigo = typeof q.erro === 'string' ? q.erro : undefined;
  const erro = codigo === undefined ? undefined : MENSAGENS[codigo];

  return (
    <main className="mx-auto flex min-h-screen max-w-[420px] flex-col justify-center px-5 py-12">
      <Marca />
      <h1 className="mt-5 text-2xl">Entrar no painel</h1>
      <p className="text-ink-2 mt-1 text-sm">
        Use o e-mail que a sua clínica cadastrou. Se ninguém cadastrou ainda, fale com quem cuida do
        sistema por aí.
      </p>

      {erro !== undefined && (
        <p
          role="alert"
          className="text-risco border-risco mt-5 rounded-md border px-3 py-2 text-sm"
        >
          {erro}
        </p>
      )}

      <form action={entrar} className="mt-5">
        <label className="mb-3 block">
          <span className="text-ink-2 mb-1 block text-[13px]">E-mail</span>
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className="border-fio bg-paper text-ink w-full rounded-sm border px-3 py-2"
          />
        </label>
        <label className="mb-5 block">
          <span className="text-ink-2 mb-1 block text-[13px]">Senha</span>
          <input
            name="senha"
            type="password"
            autoComplete="current-password"
            required
            className="border-fio bg-paper text-ink w-full rounded-sm border px-3 py-2"
          />
        </label>
        <button
          type="submit"
          className="bg-ink text-paper w-full rounded-pill px-4 py-2.5 font-semibold"
        >
          Entrar
        </button>
      </form>
    </main>
  );
}
