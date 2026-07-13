export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export const DEFAULT_SHUTDOWN_SIGNALS: ShutdownSignal[] = ["SIGINT", "SIGTERM"];

export function registerShutdownHandlers({
  stop,
  signals = DEFAULT_SHUTDOWN_SIGNALS,
}: {
  stop: () => Promise<void>;
  signals?: ShutdownSignal[];
}): () => void {
  let isStopping = false;
  const uniqueSignals = [...new Set(signals)];

  const handlers = uniqueSignals.map((signal) => {
    const handler = () => {
      if (isStopping) {
        return;
      }
      isStopping = true;

      void (async () => {
        try {
          await stop();
        } finally {
          process.exit(0);
        }
      })();
    };

    process.on(signal, handler);
    return { signal, handler };
  });

  return () => {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
  };
}
