import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const issuer = "https://auth.openai.com";
const scope = "openid email profile offline_access resource.invoke chatgpt.tokens.use.direct";
const keys = generateKeyPair("RS256", { extractable: true });
export const access = (account: string) => `mock-access-credential-${account}`;
export const refresh = (account: string) => `mock-refresh-credential-${account}`;
export type Grant = {
  account: string;
  challenge: string;
  nonce: string;
  redirect: string;
  consent?: boolean;
  expiresIn?: number;
  invalid?: "nonce" | "subject" | "audience" | "issuer" | "expiry" | "signature";
};
export function code(authorization: URL, account: string, overrides: Partial<Grant> = {}) {
  return Buffer.from(JSON.stringify({
    account,
    challenge: authorization.searchParams.get("code_challenge"),
    nonce: authorization.searchParams.get("nonce"),
    redirect: authorization.searchParams.get("redirect_uri"),
    ...overrides,
  })).toString("base64url");
}

export function events(...values: object[]) {
  const data = values.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join("");
  // Exercise CRLF, Unicode, and event boundaries split across network chunks.
  const bytes = new TextEncoder().encode(data);
  return new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

export function completed(text: string) {
  return {
    type: "response.completed",
    response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 20, output_tokens: 5 } },
  };
}

export function planFixture(options: {
  exchange?: (grant: Grant) => void | Promise<void>;
  renew?: (form: URLSearchParams) => Response | Promise<Response>;
  generate?: (account: string, body: any, signal: AbortSignal) => Response | Promise<Response>;
  revoke?: (form: URLSearchParams) => Response | Promise<Response>;
} = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const target = new URL(String(url));
    if (target.href === issuer + "/.well-known/jwks.json") {
      const { publicKey } = await keys;
      return Response.json({ keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" }] });
    }
    if (target.href === issuer + "/.well-known/openid-configuration")
      return Response.json({ revocation_endpoint: issuer + "/api/accounts/oauth/revoke" });
    if (target.href === issuer + "/api/accounts/oauth/revoke")
      return options.revoke?.(init?.body as URLSearchParams) ?? new Response();
    if (target.href === issuer + "/api/accounts/oauth/token") {
      const form = init?.body as URLSearchParams;
      assert.equal(form.get("resource"), "https://api.openai.com/v1");
      assert.equal(form.has("client_secret"), false);
      if (form.get("grant_type") === "refresh_token") {
        assert.equal(form.has("scope"), false);
        assert.ok(options.renew, "Unexpected refresh");
        return options.renew(form);
      }
      assert.equal(form.get("grant_type"), "authorization_code");
      const grant: Grant = JSON.parse(Buffer.from(form.get("code")!, "base64url").toString());
      const client = `oaiapp_${grant.account}`;
      assert.equal(form.get("client_id"), client);
      assert.equal(form.get("redirect_uri"), grant.redirect);
      assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), grant.challenge);
      await options.exchange?.(grant);
      const { privateKey } = await (grant.invalid === "signature" ? generateKeyPair("RS256") : keys);
      const token = await new SignJWT({ nonce: grant.invalid === "nonce" ? "bad-nonce" : grant.nonce, email: "mock@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(grant.invalid === "issuer" ? "https://elsewhere.test" : issuer)
        .setSubject(grant.invalid === "subject" ? "wrong-subject" : `mock-subject-${grant.account}`)
        .setAudience(grant.invalid === "audience" ? "wrong-audience" : client)
        .setIssuedAt()
        .setExpirationTime(grant.invalid === "expiry" ? "0s" : "5m")
        .sign(privateKey);
      return Response.json({
        access_token: access(grant.account),
        refresh_token: refresh(grant.account),
        token_type: "Bearer",
        id_token: token,
        expires_in: grant.expiresIn ?? 3600,
        scope: grant.consent === false ? "openid profile email offline_access" : scope,
      });
    }
    assert.equal(target.origin, "https://api.openai.com");
    const authorization = new Headers(init?.headers).get("Authorization");
    assert.ok(authorization && authorization.startsWith("Bearer mock-access-credential-"));
    const account = authorization.slice("Bearer mock-access-credential-".length);
    if (target.pathname === "/v1/models") return Response.json({ models: [
      { slug: "gpt-6.1-sol", display_name: "Plan Vision", visibility: "list",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "unheard-of" }],
        default_reasoning_level: "medium" },
      { slug: `unknown-${account}`, display_name: "Plan Text", visibility: "list" },
      { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
    ] });
    assert.equal(target.pathname, "/v1/responses");
    const body = JSON.parse(init?.body as string);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.ok(body.instructions);
    assert.equal(body.max_output_tokens, undefined);
    return options.generate?.(account, body, init!.signal!) ?? events(completed(`Answer billed to ${account} ✓`));
  };
  return { calls, fetcher };
}
