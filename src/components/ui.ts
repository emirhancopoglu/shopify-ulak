/** Ortak Tailwind sınıfları (bileşen kütüphanesi yerine). */
export const ui = {
  card: "rounded-lg border border-stone-200 bg-white",
  input:
    "h-9 w-full rounded-md border border-stone-300 bg-white px-2.5 outline-none focus:border-stone-500 disabled:bg-stone-50 disabled:text-stone-500",
  textarea:
    "w-full rounded-md border border-stone-300 bg-white px-3 py-2 outline-none focus:border-stone-500 disabled:bg-stone-50",
  label: "mb-1 block text-[13px] font-medium text-stone-700",
  hint: "mt-1 text-xs text-stone-500",
  btn: "inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 whitespace-nowrap hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40",
  btnPrimary:
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-stone-900 px-4 font-medium whitespace-nowrap text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40",
  btnDanger:
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-red-200 bg-white px-3 whitespace-nowrap text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40",
  h1: "text-xl font-semibold tracking-tight",
  h2: "text-[15px] font-semibold",
  sub: "text-stone-500",
};

export type FormState = { ok: boolean; message: string } | null;
