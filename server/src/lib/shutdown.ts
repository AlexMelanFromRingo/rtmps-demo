import { log } from './log.ts';

type Hook = () => Promise<void> | void;
const hooks: Hook[] = [];
let shuttingDown = false;

export const isShuttingDown = () => shuttingDown;

// Hooks run in reverse registration order (last started, first stopped).
export function onShutdown(hook: Hook): void {
  hooks.push(hook);
}

export function installSignalHandlers(timeoutMs = 20_000): void {
  const run = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    for (const hook of hooks.reverse()) {
      try {
        await hook();
      } catch (err) {
        log.error({ err }, 'shutdown hook failed');
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void run('SIGTERM'));
  process.on('SIGINT', () => void run('SIGINT'));
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
