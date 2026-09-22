import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://demo.fliqo.com.br'),
  title: 'Fliqo — demonstração',
  description:
    'Agenda que não perde horário, atendimento pelo WhatsApp e caixa ligado à agenda. Ambiente de demonstração com dados fictícios.',
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    siteName: 'Fliqo',
    title: 'Fliqo — demonstração',
    description:
      'Veja em seis cenas como a clínica para de perder horário: confirmação de véspera, lista de espera, atraso avisado antes de o paciente sair de casa e o caixa que vem da agenda.',
    images: [{ url: '/compartilhar.png', width: 1200, height: 630, alt: 'Fliqo' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Fliqo — demonstração',
    description: 'A agenda da clínica que não perde horário.',
    images: ['/compartilhar.png'],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#eef1f0' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1211' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700&family=Schibsted+Grotesk:wght@700;800&family=Spline+Sans+Mono:wght@400;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
