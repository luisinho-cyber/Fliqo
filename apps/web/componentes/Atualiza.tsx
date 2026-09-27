'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Recarrega a tela de tempos em tempos.
 *
 * O atraso muda sem ninguém clicar em nada: um atendimento que passou do tempo
 * desloca o dia inteiro. Sem isto, a recepção olharia para uma previsão de dez
 * minutos atrás e mandaria o paciente entrar na hora errada.
 */
export function Atualiza({ intervaloMs = 60_000 }: { intervaloMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
    }, intervaloMs);
    return () => {
      clearInterval(id);
    };
  }, [router, intervaloMs]);

  return null;
}
