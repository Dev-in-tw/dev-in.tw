/** RFC 9116 security.txt（PLAN §2.3）。Expires 一年後，每次部署都會更新。 */
export const dynamic = "force-static";

export function GET() {
  const expires = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const body = [
    "Contact: mailto:security@dev-in.tw",
    `Expires: ${expires}`,
    "Preferred-Languages: zh-Hant, en",
    "Canonical: https://dev-in.tw/.well-known/security.txt",
    "Policy: https://github.com/Dev-in-tw/dev-in.tw/security/policy",
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
