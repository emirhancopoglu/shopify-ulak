"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Analiz sürerken tabloyu birkaç saniyede bir tazeler. */
export function AutoRefresh({ active, intervalMs = 2500 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  return null;
}
