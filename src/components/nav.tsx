"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: { href: string; label: string; soon?: string }[] = [
  { href: "/stores", label: "Mağazalar" },
  { href: "/discover", label: "Keşif" },
  { href: "/templates", label: "Şablonlar" },
  { href: "/campaigns", label: "Kampanyalar" },
  { href: "/settings", label: "Ayarlar" },
];

/** Adres bilgisini okuyan kısım; layout'ta <Suspense> içinde, yedeği <NavFrame /> (vurgusuz). */
export function Nav() {
  return <NavFrame pathname={usePathname()} />;
}

export function NavFrame({ pathname = "" }: { pathname?: string }) {
  return (
    <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-stone-200 bg-white px-3 py-5 md:flex">
      <div className="mb-6 px-2">
        <div className="text-[15px] font-semibold tracking-tight">Mail Templater</div>
        <div className="text-xs text-stone-500">Shopify outreach</div>
      </div>
      <nav className="flex flex-col gap-0.5">
        {ITEMS.map((item) => {
          const active = Boolean(pathname) && pathname.startsWith(item.href);
          if (item.soon) {
            return (
              <span key={item.href} className="flex items-center justify-between rounded-md px-2 py-1.5 text-stone-400">
                {item.label}
                <span className="rounded bg-stone-100 px-1.5 text-[10px] font-medium text-stone-500">{item.soon}</span>
              </span>
            );
          }
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-2 py-1.5 ${active ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100"}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
