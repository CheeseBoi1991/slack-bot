import crypto from "node:crypto";

// GitHub's REST API is date-versioned. 2022-11-28 is not the newest release,
// but it is still supported (through 10 March 2028) and is what an unversioned
// request defaults to — so pinning it is a deliberate, stable choice. Sending
// it explicitly means a future change to the default can't move us. Re-check
// docs.github.com/en/rest/about-the-rest-api/api-versions when this ages.
const GITHUB_API_VERSION = "2022-11-28";

const ENV_VARS = ["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"];

/**
 * Whether anyone set up the GitHub feature at all. Any one of the three vars
 * counts: a half-configured App is "configured but broken" and gets a visible
 * warning from mintInstallationToken, while none set means the feature is off
 * and the bot stays silent about it.
 */
export function isGithubConfigured() {
  return ENV_VARS.some((name) => process.env[name]);
}

/**
 * The App private key, decoded. It is stored base64-encoded because multiline
 * env vars don't survive the trip into Vercel cleanly.
 */
function readPrivateKey() {
  // Stored base64-encoded to survive multiline env var handling.
  const privateKey = Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY, "base64").toString("utf8");

  if (!privateKey.trimStart().startsWith("-----BEGIN")) {
    // Without this check a raw-PEM or truncated value surfaces later as an
    // opaque OpenSSL "error:1E08010C:DECODER routines::unsupported".
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY does not decode to a PEM key. It is expected to be the .pem file base64-encoded onto a single line.",
    );
  }
  return privateKey;
}

/**
 * A GitHub App JWT: RS256, three claims, valid for 9 minutes. Hand-rolled over
 * node:crypto rather than a JWT library — this repo has already been bitten by
 * an ESM-only dependency breaking Vercel's bundler, and this is ~15 lines.
 */
function signAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: now - 60, // back-dated to absorb clock skew; GitHub rejects future-dated JWTs
    exp: now + 9 * 60, // the hard limit is 10 minutes; leave margin
    // The numeric App ID. GitHub's docs now recommend the App's client ID here
    // and treat the numeric ID as the older form; both are accepted, and the
    // numeric ID is what GITHUB_APP_ID holds.
    iss: appId,
  })}`;

  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

/**
 * Mints a one-hour GitHub App installation token.
 *
 * Runs in the Vercel function and nowhere else: the App private key never
 * enters the sandbox. The sandbox is handed only the expiring token — a
 * capability that dies on its own — not the key that mints capabilities.
 *
 * Minted fresh on every call and deliberately not cached across warm
 * invocations, so "a token per request" is literally true. A cache would hand
 * one request a token another request's sandbox already holds, and one with
 * less than its full hour left.
 *
 * Never logs the token, and never assumes anything about its format or length.
 *
 * @returns {Promise<string>} the installation token
 * @throws on missing config or any GitHub error; the caller degrades softly
 */
export async function mintInstallationToken() {
  const missing = ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`GitHub App is partly configured; missing ${missing.join(", ")}`);
  }

  const jwt = signAppJwt(process.env.GITHUB_APP_ID, readPrivateKey());

  const res = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(process.env.GITHUB_INSTALLATION_ID)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "joestar-agent",
      },
    },
  );

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 401: bad JWT (wrong key or App ID) or a skewed clock.
    // 404: wrong installation ID.
    throw new Error(`GitHub returned ${res.status} minting a token: ${body.message ?? "no message"}`);
  }
  if (!body.token) throw new Error("GitHub's token response had no token field");

  return body.token;
}
