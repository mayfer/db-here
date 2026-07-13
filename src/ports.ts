import { createServer } from "node:net";

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function findAvailablePort(
  startPort: number,
  maxAttempts = 1000
): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(
    `No available port found after ${maxAttempts} attempts starting from ${startPort}`
  );
}

export async function resolvePort(options: {
  port?: number;
  defaultPort: number;
  autoPort?: boolean;
}): Promise<number> {
  const autoPortEnabled = options.autoPort ?? true;
  const usingDefaultPort = options.port === undefined;

  const port =
    usingDefaultPort && autoPortEnabled
      ? await findAvailablePort(options.defaultPort)
      : (options.port ?? options.defaultPort);

  if (port !== options.defaultPort && usingDefaultPort) {
    console.warn(
      `Port ${options.defaultPort} is in use, using port ${port} instead`
    );
  }

  return port;
}
