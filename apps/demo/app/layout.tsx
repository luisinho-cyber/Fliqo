import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://demo.fliqo.com.br'),
  title: 'Fliqo — demonstração',
  description:
    'A agenda da clínica em funcionamento: chegada, início e fim do atendimento, o atraso deslocando o dia, a confirmação pelo WhatsApp e a lista de espera reocupando o horário. Dados fictícios.',
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    siteName: 'Fliqo',
    title: 'Fliqo — demonstração',
    description:
      'A agenda da clínica em funcionamento, com dados fictícios: os três toques do atendimento, o atraso deslocando o dia, a confirmação pelo WhatsApp e a lista de espera.',
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
    { media: '(prefers-color-scheme: dark)', color: '#0b1210' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/*
          Sora faz título e corpo; DM Mono faz medida. O corpo para em 600: o peso
          do título é do título (DESIGN.md).
        */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
