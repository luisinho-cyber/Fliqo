/** Telas de estado escritas à mão, em português de quem opera a clínica. */
export function Indisponivel({ oQue }: { oQue: string }) {
  return (
    <div className="border-fio rounded-md border border-dashed p-5">
      <p className="font-semibold">Não consegui carregar {oQue}.</p>
      <p className="text-ink-2 mt-1 text-sm">
        A clínica continua funcionando — foi esta tela que não conseguiu falar com o servidor.
        Atualize daqui a pouco. Se continuar assim, atenda pelo telefone e avise quem cuida do
        sistema.
      </p>
    </div>
  );
}

export function Vazio({ titulo, detalhe }: { titulo: string; detalhe: string }) {
  return (
    <div className="border-fio rounded-md border border-dashed p-5">
      <p className="font-semibold">{titulo}</p>
      <p className="text-ink-2 mt-1 text-sm">{detalhe}</p>
    </div>
  );
}
