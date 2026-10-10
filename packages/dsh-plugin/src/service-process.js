/** Own local DreamMate service processes; existing and remote servers keep their external owner. */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const leases = new Map();
/** Validate lifecycle options before any process or connection is created. */
export function resolveServiceOptions(input) {
    const result = {
        serviceUrl: input.serviceUrl ?? 'http://127.0.0.1:36908',
        serviceMode: input.serviceMode ?? 'auto',
        serviceHost: input.serviceHost ?? '0.0.0.0',
        serviceStartupTimeoutMs: input.serviceStartupTimeoutMs ?? 15_000,
        serviceShutdownTimeoutMs: input.serviceShutdownTimeoutMs ?? 5_000,
    };
    const url = new URL(result.serviceUrl);
    if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('serviceUrl must use http or https');
    if (!['0.0.0.0', '127.0.0.1', '::', '::1'].includes(result.serviceHost))
        throw new Error('serviceHost must be a loopback or wildcard listen address');
    if (url.username || url.password || url.search || url.hash)
        throw new Error('serviceUrl must not contain credentials, query or fragment');
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    result.serviceUrl = url.href.replace(/\/+$/, '');
    if (url.hostname === '[::1]' && input.serviceHost === undefined) result.serviceHost = '::';
    if (!['auto', 'external'].includes(result.serviceMode))
        throw new Error('serviceMode must be auto or external');
    for (const value of [result.serviceStartupTimeoutMs, result.serviceShutdownTimeoutMs]) {
        if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
            throw new Error('DreamMate service timeouts must be integers between 1 and 2147483647');
    }
    if (url.port === '0')
        throw new Error('serviceUrl needs a stable, nonzero port for node discovery');
    return result;
}
function refused(error) {
    if (!error || typeof error !== 'object')
        return false;
    if (error instanceof AggregateError)
        return error.errors.length > 0 && error.errors.every(refused);
    if ('code' in error && error.code === 'ECONNREFUSED')
        return true;
    return 'cause' in error && refused(error.cause);
}
async function running(url, timeout) {
    let response;
    try {
        response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(timeout), redirect: 'error' });
    }
    catch (error) {
        if (refused(error))
            return false;
        throw new Error(`DreamMate health check failed at ${url.origin}`, { cause: error });
    }
    if (!response.ok)
        throw new Error(`DreamMate health check failed: HTTP ${response.status} at ${url.origin}`);
    const body = await response.json();
    if (!body || typeof body !== 'object' || !('service' in body) || body.service !== 'node-agent' || !('status' in body) || body.status !== 'ok') {
        throw new Error(`The listener at ${url.origin} is not a healthy DreamMate service`);
    }
    return true;
}
async function start(options, url) {
    if (await running(url, options.serviceStartupTimeoutMs))
        return async () => { };
    const child = fork(fileURLToPath(new URL('./service-worker.js', import.meta.url)), [], {
        execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const ready = Promise.withResolvers();
    const closed = Promise.withResolvers();
    let ended = false;
    child.once('error', error => ready.reject(error));
    child.once('close', (code, signal) => {
        ended = true;
        ready.reject(new Error(`Managed DreamMate service exited (${signal ?? code})`));
        closed.resolve();
    });
    child.on('message', message => {
        if (!message || typeof message !== 'object' || !('type' in message))
            return;
        if (message.type === 'ready')
            ready.resolve();
        if (message.type === 'error' && 'message' in message && typeof message.message === 'string')
            ready.reject(Object.assign(new Error(message.message), { code: message.code }));
    });
    let stopping;
    const stop = () => stopping ??= (async () => {
        if (ended)
            return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), options.serviceShutdownTimeoutMs);
        try {
            await closed.promise;
        }
        finally {
            clearTimeout(timer);
        }
    })();
    const timer = setTimeout(() => ready.reject(new Error(`DreamMate service startup timed out after ${options.serviceStartupTimeoutMs}ms`)), options.serviceStartupTimeoutMs);
    child.send({ host: options.serviceHost, port: Number(url.port || 80), shutdownTimeoutMs: options.serviceShutdownTimeoutMs }, error => { if (error)
        ready.reject(error); });
    try {
        await ready.promise;
        if (!await running(url, options.serviceStartupTimeoutMs))
            throw new Error('DreamMate service exited during startup');
        return stop;
    }
    catch (error) {
        await stop();
        // A concurrent DSH process may have won the bind after our first probe.
        if (error.code === 'EADDRINUSE' && await running(url, options.serviceStartupTimeoutMs))
            return async () => {};
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
/** Acquire a shared local process lease; release waits for owned process exit, never kills an existing server. */
export async function acquireService(options) {
    const url = new URL(options.serviceUrl);
    const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
    if (options.serviceMode === 'external' || !local)
        return async () => { };
    const key = url.origin;
    let lease = leases.get(key);
    if (lease?.closing) {
        await lease.closing;
        return acquireService(options);
    }
    if (!lease) {
        lease = { users: 0, ready: start(options, url) };
        leases.set(key, lease);
    }
    lease.users++;
    let stop;
    try {
        stop = await lease.ready;
    }
    catch (error) {
        if (--lease.users === 0)
            leases.delete(key);
        throw error;
    }
    let released = false;
    return async () => {
        if (released)
            return;
        released = true;
        if (--lease.users !== 0)
            return;
        lease.closing = stop();
        try {
            await lease.closing;
        }
        finally {
            if (leases.get(key) === lease)
                leases.delete(key);
        }
    };
}
