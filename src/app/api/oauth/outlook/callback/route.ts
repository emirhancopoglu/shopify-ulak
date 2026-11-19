import { NextResponse, type NextRequest } from "next/server";
import { upsertOutlookAccount } from "@/lib/accounts";
import { classifySendError, verifyOutlook } from "@/lib/mailer";
import { CALLBACK_PATH, exchangeCode, explainMicrosoftError, getOutlookClientId } from "@/lib/outlook";

const COOKIE = "outlook_oauth";

/** Microsoft girişten dönüş: kodu anahtarla değiştir, SMTP'yi dene, hesabı kaydet. */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const back = (params: Record<string, string>) => {
    const res = NextResponse.redirect(new URL(`/settings?${new URLSearchParams(params)}`, request.url));
    res.cookies.delete({ name: COOKIE, path: "/api/oauth/outlook" });
    return res;
  };

  const msError = url.searchParams.get("error");
  if (msError) {
    const desc = url.searchParams.get("error_description") ?? "";
    const text = msError === "access_denied" && !/AADSTS/.test(desc) ? "Microsoft girişi iptal edildi." : explainMicrosoftError(msError, desc);
    return back({ outlook_error: text });
  }

  let saved: { state: string; verifier: string } | null = null;
  try {
    saved = JSON.parse(request.cookies.get(COOKIE)?.value ?? "null");
  } catch {
    saved = null;
  }
  const code = url.searchParams.get("code");
  if (!saved || !code || url.searchParams.get("state") !== saved.state) {
    return back({ outlook_error: "Oturum doğrulanamadı (süre dolmuş olabilir). Tekrar \"Outlook hesabı bağla\"ya tıklayın." });
  }

  const clientId = getOutlookClientId();
  if (!clientId) return back({ outlook_error: "Outlook Client ID ayarlı değil." });

  try {
    const redirectUri = new URL(CALLBACK_PATH, url.origin).toString();
    const t = await exchangeCode({ clientId, code, redirectUri, verifier: saved.verifier });
    if (!t.email) return back({ outlook_error: "Microsoft hesabın mail adresini döndürmedi." });
    await verifyOutlook(t.email, t.accessToken);
    const r = upsertOutlookAccount({ email: t.email, name: t.name, refreshToken: t.refreshToken });
    return back({ outlook_connected: t.email, ...(r.created ? {} : { outlook_reconnected: "1" }) });
  } catch (err) {
    const { message } = classifySendError(err, "outlook");
    return back({ outlook_error: message });
  }
}
