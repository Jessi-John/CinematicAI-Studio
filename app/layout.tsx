import type { Metadata } from "next";
import { headers } from "next/headers";
import Script from "next/script";
import "./globals.css";
import { AppShell } from "@/components/layout/app-shell";
import { QueryProvider } from "@/lib/query/client";
import { AuthProvider } from "@/lib/auth/auth-context";

export const metadata: Metadata = {
  title: "CinematicAI Studio | AI Storytelling for YouTube Shorts",
  description: "Generate cinematic, anime-style stories for YouTube Shorts with AI. Create unique, copyright-safe content in minutes.",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎬</text></svg>",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get('x-csp-nonce') ?? undefined;

  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-[var(--bg-primary)] font-sans" nonce={nonce}>
        <Script
          src="/runtime-config.js"
          strategy="beforeInteractive"
          nonce={nonce}
        />
        <QueryProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
