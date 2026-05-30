import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";


// Configuração das fontes para melhor performance e design
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Consolidação dos Metadados e Ícones
export const metadata: Metadata = {
  title: "Jarvis | Lev",
  description: "Seu assistente pessoal inteligente",
  icons: {
    icon: "/icon.png",
    apple: "/icon.png",
    shortcut: "/icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}