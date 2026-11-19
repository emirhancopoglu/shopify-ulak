import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Account } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/secret";
import { getSetting } from "@/lib/settings";

/**
 * Kişisel Outlook.com / Hotmail hesapları için OAuth 2.0 (yetkilendirme kodu + PKCE, gizli anahtarsız).
 * Microsoft kişisel hesaplarda şifreyle SMTP'yi kapattığı için tek yol bu.
 * Gönderim: smtp-mail.outlook.com:587 + XOAUTH2 (List-Unsubscribe başlığını koruyabilmek için Graph yerine SMTP).
 */
const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
export const OUTLOOK_SCOPES = "openid profile email offline_access https://outlook.office.com/SMTP.Send";
export const CALLBACK_PATH = "/api/oauth/outlook/callback";
export const CLIENT_ID_KEY = "outlook_client_id";

/** .env'deki OUTLOOK_CLIENT_ID önceliklidir; yoksa Ayarlar ekranından kaydedilen değer. */
export const outlookClientIdFromEnv = () => process.env.OUTLOOK_CLIENT_ID?.trim() || null;
export const getOutlookClientId = () => outlookClientIdFromEnv() ?? getSetting(CLIENT_ID_KEY);

/** Hata nesnesi "EAUTH" kodu taşır; mailer.classifySendError bunu "auth" sayar → kampanya duraklar. */
export class OutlookAuthError extends Error {
  code = "EAUTH";
}

// --- PKCE ---------------------------------------------------------------------

const b64url = (buf: Buffer) => buf.toString("base64url");

export function createPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  return { verifier, challenge, state };
}

export function authorizeUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string }) {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    redirect_uri: p.redirectUri,
    response_mode: "query",
    scope: OUTLOOK_SCOPES,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${AUTHORITY}/authorize?${q}`;
}

// --- Token uç noktası -----------------------------------------------------------

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };

/** Kurulumda en sık yapılan Azure hatalarını (AADSTS kodları) Türkçe çözüme çevirir. */
export function explainMicrosoftError(error: string | undefined, description: string | undefined): string {
  const desc = (description ?? "").split(/\r?\n/)[0].replace(/\s*Trace ID:.*$/i, "").trim();
  const code = desc.match(/AADSTS\d+/)?.[0];
  switch (code) {
    case "AADSTS7000218":
      return "Azure'daki dönüş adresi \"Web\" platformunda kayıtlı. Uygulama kaydında Authentication → platformu \"Mobile and desktop applications\" olarak ekleyin (ya da \"Allow public client flows\"u açın).";
    case "AADSTS9002327":
      return "Dönüş adresi \"Single-page application\" olarak kayıtlı. \"Mobile and desktop applications\" platformuna taşıyın.";
    case "AADSTS50011":
      return "Dönüş adresi Azure'dakiyle aynı değil. Ayarlar'da gösterilen adresi Azure'a birebir ekleyin.";
    case "AADSTS700016":
    case "AADSTS700038":
      return "Client ID bulunamadı. Doğru \"Application (client) ID\"yi kopyaladığınızdan ve hesap türünün \"Personal Microsoft accounts\" olduğundan emin olun.";
    case "AADSTS50020":
    case "AADSTS90072":
      return "Bu hesap uygulama kaydının hesap türüyle uyuşmuyor. Kişisel bir Outlook/Hotmail hesabıyla giriş yapın ve kaydı \"Personal Microsoft accounts only\" yapın.";
    case "AADSTS65001":
      return "İzin verilmedi. Bağlanırken Microsoft'un sorduğu izinleri onaylayın.";
  }
  return `Microsoft girişi tamamlanamadı: ${code ? desc : `${error ?? ""} ${desc}`.trim()}`.slice(0, 300);
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    // Yenileme sırasında invalid_grant = oturum düşmüş/izin geri alınmış
    if (params.grant_type === "refresh_token" && json.error === "invalid_grant") {
      throw new OutlookAuthError("Outlook oturumu sona erdi veya izin geri alındı. Ayarlar'dan hesabı yeniden bağlayın.");
    }
    throw new OutlookAuthError(explainMicrosoftError(json.error ?? String(res.status), json.error_description));
  }
  return json as TokenResponse;
}

/** id_token içeriği (token uç noktasından TLS ile geldiği için imza doğrulaması gerekmez). */
function idClaims(idToken?: string): { email?: string; name?: string } {
  if (!idToken) return {};
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as Record<string, string>;
    return { email: (payload.email ?? payload.preferred_username)?.toLowerCase(), name: payload.name };
  } catch {
    return {};
  }
}

export async function exchangeCode(p: { clientId: string; code: string; redirectUri: string; verifier: string }) {
  const t = await tokenRequest({
    client_id: p.clientId,
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
    scope: OUTLOOK_SCOPES,
  });
  if (!t.refresh_token) throw new OutlookAuthError("Microsoft yenileme anahtarı (refresh token) vermedi; offline_access izni gerekli.");
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, ...idClaims(t.id_token) };
}

// --- Hesap için erişim anahtarı (önbellekli, gerekirse yenilenir) -----------------

type StoredSecret = { refreshToken: string };
const cache = new Map<number, { token: string; expiresAt: number }>();

export const encodeOutlookSecret = (refreshToken: string) => encrypt(JSON.stringify({ refreshToken } satisfies StoredSecret));

export async function outlookAccessToken(account: Account): Promise<string> {
  const hit = cache.get(account.id);
  if (hit && hit.expiresAt - 120_000 > Date.now()) return hit.token;

  const clientId = getOutlookClientId();
  if (!clientId) throw new OutlookAuthError("Outlook Client ID ayarlı değil (Ayarlar).");

  // Web ve worker aynı anda yenilemiş olabilir: her seferinde DB'deki en güncel anahtarı oku
  const fresh = db.select({ secret: schema.accounts.secret }).from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
  const { refreshToken } = JSON.parse(decrypt(fresh?.secret ?? account.secret)) as StoredSecret;

  const t = await tokenRequest({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken, scope: OUTLOOK_SCOPES });
  cache.set(account.id, { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 });
  // Microsoft her yenilemede yeni bir refresh token verir; saklamazsak ~90 gün sonra oturum düşer
  if (t.refresh_token && t.refresh_token !== refreshToken) {
    db.update(schema.accounts).set({ secret: encodeOutlookSecret(t.refresh_token) }).where(eq(schema.accounts.id, account.id)).run();
  }
  return t.access_token;
}

export function forgetOutlookToken(accountId: number) {
  cache.delete(accountId);
}
