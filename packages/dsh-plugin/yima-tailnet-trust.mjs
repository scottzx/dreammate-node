// Loader adapter shipped with the DreamMate DSH plugin; it keeps the contract
// of the standalone dsh-config profile extension of the same name. DSH's
// installed Connection carrier: Tailscale Serve preserves Host, so the exact
// private authority must pass its fence before the web entry may be reached.
export const name = 'yima-tailnet-trust';
export const inject = ['connection'];

export function apply(ctx, config) {
  const authority = config.authority;
  let parsed;
  try { parsed = new URL(`https://${authority}`); } catch { /* handled below */ }
  if (typeof authority !== 'string' || !parsed || parsed.host !== authority ||
      !/^[a-z0-9.-]+$/.test(parsed.hostname) ||
      !parsed.hostname.endsWith('.ts.net') || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('yima-tailnet-trust: an exact Tailscale DNS host:port is required');
  }
  const connection = ctx.connection;
  if (!Array.isArray(connection?.trustedHosts)) {
    throw new Error('yima-tailnet-trust: installed Connection contract has changed');
  }
  return ctx.effect(() => {
    const added = !connection.trustedHosts.includes(authority);
    if (added) connection.trustedHosts.push(authority);
    return () => {
      if (added) {
        const index = connection.trustedHosts.indexOf(authority);
        if (index !== -1) connection.trustedHosts.splice(index, 1);
      }
    };
  });
}
