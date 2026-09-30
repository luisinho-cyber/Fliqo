import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fliqo',
  description: 'O painel da clínica.',
  // Painel de clínica não é página pública, e o que há dentro é dado de saúde.
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
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600&family=Schibsted+Grotesk:wght@700;800&family=Spline+Sans+Mono:wght@400;500&display=swap"
        />
      </head>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
