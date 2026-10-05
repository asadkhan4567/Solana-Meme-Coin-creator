import crypto from "node:crypto";

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding (stricter than encodeURIComponent). */
export const pctEncode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * OAuth 1.0a HMAC-SHA1 Authorization header (what X requires to post on behalf of an account).
 * `bodyParams` = only form-urlencoded body fields; JSON and multipart bodies are not signed.
 */
export function oauth1Header(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  bodyParams: Record<string, string> = {},
  nonce: string = crypto.randomBytes(16).toString("hex"),
  timestamp: string = Math.floor(Date.now() / 1000).toString(),
): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const all: [string, string][] = [
    ...Object.entries(oauth),
    ...Object.entries(bodyParams),
    ...[...u.searchParams.entries()],
  ];
  const paramString = all
    .map(([k, v]) => [pctEncode(k), pctEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const baseString = [method.toUpperCase(), pctEncode(baseUrl), pctEncode(paramString)].join("&");
  const key = `${pctEncode(creds.consumerSecret)}&${pctEncode(creds.tokenSecret)}`;
  const signature = crypto.createHmac("sha1", key).update(baseString).digest("base64");
  const header = { ...oauth, oauth_signature: signature };
  return (
    "OAuth " +
    Object.entries(header)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${pctEncode(k)}="${pctEncode(v)}"`)
      .join(", ")
  );
}
