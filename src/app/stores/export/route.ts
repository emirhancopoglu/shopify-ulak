import { parseFilters } from "@/lib/store-filters";
import { queryStoresForExport } from "@/lib/stores";

/** Mevcut filtreye uyan mağazaları CSV olarak indirir: /stores/export?<filtreler> */
export async function GET(request: Request) {
  const filters = parseFilters(new URL(request.url).searchParams);
  const rows = queryStoresForExport(filters);

  const header = [
    "domain",
    "marka",
    "durum",
    "mail",
    "mail_mx",
    "mail_sayisi",
    "ulke",
    "sehir",
    "dil",
    "para_birimi",
    "kategori",
    "urun_sayisi",
    "fiyat_min",
    "fiyat_max",
    "son_urun",
    "tema",
    "uygulamalar",
    "instagram",
    "tr_puani",
    "kaynak",
  ];
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    // Excel formül enjeksiyonunu önle
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",;\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = rows.map((r) =>
    [
      r.domain,
      r.brandNameOverride ?? r.brandName,
      r.status,
      r.primaryEmail,
      r.primaryMx === null ? "" : r.primaryMx ? "var" : "yok",
      r.emailCount,
      r.country,
      r.city,
      r.language,
      r.currency,
      r.category,
      r.productCount,
      r.priceMin,
      r.priceMax,
      r.lastProductAt,
      r.themeName,
      (r.apps ?? []).join(" | "),
      r.socials?.instagram,
      r.trScore,
      r.source,
    ]
      .map(esc)
      .join(","),
  );

  // BOM: Excel'in Türkçe karakterleri doğru açması için
  const csv = "﻿" + [header.join(","), ...lines].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="magazalar-${stamp}.csv"`,
    },
  });
}
