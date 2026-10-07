import './globals.css';
import type { Metadata, Viewport } from 'next';
export const metadata: Metadata = { title: 'Toolroom', manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'Toolroom', statusBarStyle: 'black-translucent' } };
export const viewport: Viewport = { themeColor: '#020617', width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false };
export default function Root({ children }: { children: React.ReactNode }) {
  return <html lang="hi"><body className="min-h-screen bg-slate-950 text-slate-100 font-sans">{children}</body></html>;
}
