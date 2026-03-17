// app/wm/layout.tsx
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'White Martins — Lab. Instrumentação',
  description: 'Sistema de gestão de equipamentos',
  icons: {
    icon: '/icon.png',
    apple: '/icon.png',
  },
}

export default function WMLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}