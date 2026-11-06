
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { setupGlobalProxy } = await import('./lib/global-proxy');
        setupGlobalProxy();

        const { startKeepAlive } = await import('./lib/keep-alive');
        startKeepAlive();
    }
}
