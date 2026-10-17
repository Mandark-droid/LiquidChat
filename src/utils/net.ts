/**
 * Hosts on the phone or the local network, where plaintext http is tolerated
 * (a vLLM box on the LAN, a dev MCP server). Matched exactly — prefixes such as
 * "10.evil.com" or "localhost.attacker.net" are public hosts.
 */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some(x => x > 255)) return false;
  return (
    o[0] === 127 ||
    o[0] === 10 ||
    (o[0] === 192 && o[1] === 168) ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
  );
}
