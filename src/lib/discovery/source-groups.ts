// Client-safe: DB import yok. Keşif kaynaklarının hangi sekmeye ait olduğu.
import type { DiscoverySource } from "@/db/schema";

/** Genel siteler sekmesi (F6 Faz 3): ana sayfa platform tespiti ile eklenir. */
export const GENERAL_SOURCES = ["general_ccdomains", "general_tranco"] as const satisfies readonly DiscoverySource[];

export const isGeneralSource = (source: DiscoverySource): boolean => (GENERAL_SOURCES as readonly DiscoverySource[]).includes(source);
