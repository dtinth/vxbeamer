/**
 * The bare-bones page behind `/pair`: sign in with OIDC, then show a pairing
 * link (and its QR code) that any vxbeamer client can redeem for a session.
 *
 * It is the one place the OIDC code flow runs, so a client never has to: it
 * only carries the link across. The provider must therefore allow
 * `<backend>/pair` as a redirect URI.
 *
 * Self-contained on purpose — one string, no build step, no assets — and it
 * writes dynamic text with `textContent`. The only HTML it injects is the QR
 * SVG this same server rendered.
 */
export const pairPageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Pair a client with vxbeamer</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 28rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  button { font: inherit; padding: 0.5rem 1rem; margin: 0.25rem 0.25rem 0.25rem 0; }
  input { font: 0.875rem monospace; width: 100%; box-sizing: border-box; padding: 0.5rem; }
  #qr svg { width: 14rem; height: 14rem; background: #fff; display: block; margin: 1rem 0; }
  #error { color: #c00; }
  [hidden] { display: none; }
</style>
</head>
<body>
<h1>Pair a client with vxbeamer</h1>
<p id="status"></p>
<p id="error" role="alert"></p>
<div id="signin" hidden>
  <p>Sign in to create a code for one of your own devices or apps.</p>
  <button id="signin-button">Sign in</button>
</div>
<div id="code" hidden>
  <p>Open this link in the client, or paste it into its pairing box. A phone can scan the QR code.</p>
  <div id="qr"></div>
  <input id="link" readonly aria-label="Pairing link">
  <p><button id="copy">Copy</button><button id="share" hidden>Share</button><button id="again">New code</button></p>
  <p id="expiry"></p>
</div>
<div id="received" hidden>
  <p>This is a pairing link. Open it in a vxbeamer client, or paste it into the client's pairing box. This page cannot use it.</p>
</div>
<script>
(function () {
  var OIDC_KEY = "vxbeamer-pair-oidc";
  var redirectUri = location.origin + "/pair";
  var accessToken = null;
  var timer = null;

  function $(id) { return document.getElementById(id); }
  function show(id, visible) { $(id).hidden = !visible; }
  function fail(error) { $("error").textContent = error instanceof Error ? error.message : String(error); }

  function randomString(bytes) {
    var array = new Uint8Array(bytes);
    crypto.getRandomValues(array);
    return base64url(array);
  }
  function base64url(bytes) {
    var text = "";
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  async function challengeFor(verifier) {
    var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64url(new Uint8Array(digest));
  }

  async function api(path, init) {
    var res = await fetch(path, init);
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.error || "Request failed (" + res.status + ")");
    return body;
  }

  async function beginSignIn() {
    var config = await api("/auth/config");
    var verifier = randomString(32);
    var state = randomString(16);
    sessionStorage.setItem(OIDC_KEY, JSON.stringify({ state: state, verifier: verifier }));
    var url = new URL(config.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "openid profile");
    url.searchParams.set("code_challenge", await challengeFor(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    location.href = url.toString();
  }

  async function finishSignIn(params) {
    var saved = JSON.parse(sessionStorage.getItem(OIDC_KEY) || "null");
    sessionStorage.removeItem(OIDC_KEY);
    history.replaceState({}, "", "/pair");
    if (!saved || saved.state !== params.get("state")) throw new Error("The sign-in expired. Please try again.");
    var config = await api("/auth/config");
    var tokenRes = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code: params.get("code"),
        redirect_uri: redirectUri,
        code_verifier: saved.verifier,
      }),
    });
    if (!tokenRes.ok) throw new Error("The sign-in could not be completed.");
    var tokens = await tokenRes.json();
    if (!tokens.id_token) throw new Error("The provider returned no ID token.");
    var session = await api("/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: tokens.id_token }),
    });
    return session.access_token;
  }

  async function mint() {
    $("error").textContent = "";
    var minted = await api("/pair/codes", {
      method: "POST",
      headers: { authorization: "Bearer " + accessToken },
    });
    $("qr").innerHTML = minted.svg;
    $("link").value = minted.link;
    show("signin", false);
    show("code", true);
    startCountdown(Date.now() + minted.expires_in * 1000);
  }

  function startCountdown(until) {
    clearInterval(timer);
    function tick() {
      var left = Math.max(0, Math.round((until - Date.now()) / 1000));
      $("expiry").textContent = left > 0 ? "Valid for " + left + " s, and only once." : "This code has expired. Make a new one.";
      if (left === 0) clearInterval(timer);
    }
    tick();
    timer = setInterval(tick, 1000);
  }

  $("signin-button").onclick = function () { beginSignIn().catch(fail); };
  $("again").onclick = function () { mint().catch(fail); };
  $("copy").onclick = function () {
    navigator.clipboard.writeText($("link").value).then(function () { $("copy").textContent = "Copied"; }, fail);
  };
  if (navigator.share) {
    show("share", true);
    $("share").onclick = function () { navigator.share({ url: $("link").value }).catch(function () {}); };
  }

  async function main() {
    if (location.hash.length > 1) return show("received", true);
    var params = new URLSearchParams(location.search);
    if (params.has("error")) throw new Error(params.get("error_description") || params.get("error"));
    if (params.has("code") && params.has("state")) {
      $("status").textContent = "Signing in…";
      accessToken = await finishSignIn(params);
      $("status").textContent = "";
      return mint();
    }
    show("signin", true);
  }
  main().catch(function (error) { $("status").textContent = ""; show("signin", true); fail(error); });
})();
</script>
</body>
</html>
`;
