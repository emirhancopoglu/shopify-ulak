import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { Nav, NavFrame } from "@/components/nav";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin", "latin-ext"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mail Templater",
  description: "Shopify mağazalarını bul, filtrele, şablonlu mail gönder.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="tr" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full font-sans text-sm">
        <Suspense fallback={<NavFrame />}>
          <Nav />
        </Suspense>
        <main className="min-w-0 flex-1 px-6 py-6 lg:px-10">{children}</main>
      </body>
    </html>
  );
}
