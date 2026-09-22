/** @type {import('next').NextConfig} */
export default {
  // O demo é estático: nada de banco, nada de rede. Assim ele pode ser publicado
  // em qualquer hospedagem de arquivos.
  output: 'export',
  reactStrictMode: true,
  // O lint do projeto é o da raiz (eslint.config.mjs, com as regras de fronteira
  // de import); o do Next rodaria com outra configuração e outro resultado.
  eslint: { ignoreDuringBuilds: true },
};
