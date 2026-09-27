import { redirect } from 'next/navigation';

/** A porta do painel é a tela Hoje. */
export default function Raiz(): never {
  redirect('/hoje');
}
