'use client';

import { useEffect, useState } from 'react';
import { hhmm, pct, type Janela } from '../lib/linha';

/**
 * O cursor "agora".
 *
 * É a única coisa da tela que anda sozinha, e anda no navegador porque o
 * servidor não re-renderiza a cada minuto. A posição vem do relógio do
 * visitante, mas o resto do dia — a projeção do atraso — continua sendo do
 * servidor: aqui só se desenha onde o dia está.
 */
export function Agora({ janela, fuso }: { janela: Janela; fuso: string }) {
  const [agoraMs, setAgoraMs] = useState<number | undefined>(undefined);

  useEffect(() => {
    const marcar = (): void => {
      setAgoraMs(Date.now());
    };
    marcar();
    const id = setInterval(marcar, 30_000);
    return () => {
      clearInterval(id);
    };
  }, []);

  // Antes do primeiro tique não há cursor: renderizar com a hora do servidor e
  // trocar depois causaria um pulo visível e um aviso de hidratação.
  if (agoraMs === undefined) return null;
  if (agoraMs < janela.inicioMs || agoraMs > janela.fimMs) return null;

  return (
    <div
      className="agora"
      data-t={`agora ${hhmm(agoraMs, fuso)}`}
      style={{ left: `${String(pct(agoraMs, janela))}%` }}
      aria-hidden="true"
    />
  );
}
