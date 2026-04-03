export function toWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createCodeVerifier(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

interface AuthConfig {
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

interface OidcState {
  state: string;
  codeVerifier: string;
  backendUrl: string;
  redirectUri: string;
}

const OIDC_STATE_KEY = "vxbeamer_oidc_state";

async function fetchAuthConfig(backendUrl: string): Promise<AuthConfig> {
  const res = await fetch(new URL("/auth/config", backendUrl).toString());
  if (!res.ok) throw new Error("Failed to fetch auth config");
  return res.json() as Promise<AuthConfig>;
}

export async function startSignIn(backendUrl: string): Promise<never> {
  const config = await fetchAuthConfig(backendUrl);

  const codeVerifier = createCodeVerifier();
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const state = crypto.randomUUID();
  const redirectUri = window.location.origin + window.location.pathname;

  const oidcState: OidcState = { state, codeVerifier, backendUrl, redirectUri };
  sessionStorage.setItem(OIDC_STATE_KEY, JSON.stringify(oidcState));

  const authUrl = new URL(config.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid profile");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  window.location.href = authUrl.toString();
  throw new Error("Redirecting");
}

type CallbackResult =
  | { type: "session"; accessToken: string; refreshToken: string; backendUrl: string }
  | { type: "desktop"; payload: string };

export async function createAuthUrl(backendUrl: string): Promise<{
  url: string;
  codeVerifier: string;
  state: string;
}> {
  const config = await fetchAuthConfig(backendUrl);

  const codeVerifier = createCodeVerifier();
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const state = "desktop:" + crypto.randomUUID();

  const authUrl = new URL(config.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", window.location.origin + window.location.pathname);
  authUrl.searchParams.set("scope", "openid profile");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  return {
    url: authUrl.toString(),
    codeVerifier,
    state,
  };
}

export async function exchangeDesktopCode(
  payload: string,
  codeVerifier: string,
  expectedState: string,
  backendUrl: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const [code, returnedState] = payload.split("#", 2) as [string, string];

  if (!code || !returnedState) {
    throw new Error("Invalid code format — expected <code>#<state>");
  }

  if (returnedState !== expectedState) {
    throw new Error("State mismatch");
  }

  const redirectUri = window.location.origin + window.location.pathname;
  const config = await fetchAuthConfig(backendUrl);

  const tokenRes = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) throw new Error("Token exchange failed");

  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("No id_token in token response");

  const sessionRes = await fetch(new URL("/auth/session", backendUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: tokens.id_token }),
  });
  if (!sessionRes.ok) {
    const err = (await sessionRes.json()) as { error?: string };
    throw new Error(err.error ?? "Session creation failed");
  }

  const session = (await sessionRes.json()) as { access_token?: string; refresh_token?: string };
  if (!session.access_token) throw new Error("No access_token in session response");
  if (!session.refresh_token) throw new Error("No refresh_token in session response");

  return { accessToken: session.access_token, refreshToken: session.refresh_token };
}

export async function handleCallback(): Promise<CallbackResult | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const returnedState = params.get("state");

  if (!code || !returnedState) return null;

  // Check for desktop flow: state starts with "desktop:" and no sessionStorage entry
  const stored = sessionStorage.getItem(OIDC_STATE_KEY);
  if (returnedState.startsWith("desktop:") && !stored) {
    window.history.replaceState({}, "", window.location.pathname);
    return { type: "desktop", payload: `${code}#${returnedState}` };
  }

  if (!stored) throw new Error("No OIDC state found — please sign in again");

  const { state, codeVerifier, backendUrl, redirectUri } = JSON.parse(stored) as OidcState;
  sessionStorage.removeItem(OIDC_STATE_KEY);

  if (returnedState !== state) throw new Error("State mismatch");

  window.history.replaceState({}, "", window.location.pathname);

  const config = await fetchAuthConfig(backendUrl);

  const tokenRes = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) throw new Error("Token exchange failed");

  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("No id_token in token response");

  const sessionRes = await fetch(new URL("/auth/session", backendUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: tokens.id_token }),
  });
  if (!sessionRes.ok) {
    const err = (await sessionRes.json()) as { error?: string };
    throw new Error(err.error ?? "Session creation failed");
  }

  const session = (await sessionRes.json()) as { access_token?: string; refresh_token?: string };
  if (!session.access_token) throw new Error("No access_token in session response");
  if (!session.refresh_token) throw new Error("No refresh_token in session response");

  return {
    type: "session",
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    backendUrl,
  };
}
