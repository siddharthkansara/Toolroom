import './globals.css';
import type { Metadata, Viewport } from 'next';
export const metadata: Metadata = { title: 'Toolroom', manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'Toolroom', statusBarStyle: 'black-translucent' } };
export const viewport: Viewport = { themeColor: '#020617', width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false };
// Applies the saved theme before the page paints, so there is no dark flash in light mode
const init = `try{if(localStorage.getItem('theme')==='light'){document.documentElement.setAttribute('data-theme','light')}}catch(e){}`;
export default function Root({ children }: { children: React.ReactNode }) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: init }} /></head>
    <body className="min-h-screen bg-slate-950 text-slate-100 font-sans">{children}</body></html>;
}
