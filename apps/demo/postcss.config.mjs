/*
 * O Tailwind entra aqui como COMPILADOR DE TOKENS, e não como framework de
 * utilidades: a demonstração não usa classe utilitária nenhuma e não importa
 * `tailwindcss`, então nada de preflight nem de reset.
 *
 * Ele existe porque a fonte dos tokens é `apps/web/app/tokens.css`, que declara
 * os valores num bloco `@theme` — a forma que o painel precisa para gerar as
 * utilidades dele. Sem este plugin o navegador ignoraria o bloco inteiro e a
 * demonstração ficaria sem paleta. Com ele, o mesmo arquivo serve os dois apps,
 * e é o único jeito de "a mesma fonte" ser literalmente o mesmo arquivo.
 */
export default { plugins: { '@tailwindcss/postcss': {} } };
