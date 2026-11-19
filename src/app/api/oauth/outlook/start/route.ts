import { NextResponse, type NextRequest } from "next/server";
import { authorizeUrl, CALLBACK_PATH, createPkce, getOutlookClientId } from "@/lib/outlook";

const OAUTH_COOKIE = "outlook_oauth";

/** "Outlook hesabı bağla" → Microsoft giriş sayfasına yönlendirir (PKCE). */
export function GET(request: NextRequest) {
  const clientId = getOutlookClientId();
  if (!clientId) {
    return NextResponse.redirect(new URL("/settings?outlook_error=Önce Outlook Client ID kaydedin.", request.url));
  }
  const redirectUri = new URL(CALLBACK_PATH, request.nextUrl.origin).toString();
  const { verifier, challenge, state } = createPkce();

  const res = NextResponse.redirect(authorizeUrl({ clientId, redirectUri, state, challenge }));
  // state + verifier geri dönüşte doğrulanır; 10 dk geçerli, JS erişemez
  res.cookies.set(OAUTH_COOKIE, JSON.stringify({ state, verifier }), {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/oauth/outlook",
    maxAge: 600,
  });
  return res;
}
