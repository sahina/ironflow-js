import * as net from "node:net";
import type { AddressInfo } from "node:net";

export async function startCutProxy(targetUrl: string) {
  const target = new URL(targetUrl);
  const pairs = new Set<{ client: net.Socket; upstream: net.Socket }>();
  const silent = { on: false, accepted: 0, held: new Set<net.Socket>() };
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    if (silent.on) {
      silent.accepted++;
      silent.held.add(client);
      client.on("error", () => {});
      client.on("close", () => silent.held.delete(client));
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname);
    const pair = { client, upstream };
    pairs.add(pair);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => pairs.delete(pair));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const cut = (how: (client: net.Socket) => void) => {
    for (const pair of [...pairs]) {
      pairs.delete(pair);
      pair.upstream.unpipe(pair.client);
      how(pair.client);
      pair.upstream.destroy();
    }
  };
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    reset: () => cut((client) => client.resetAndDestroy()),
    halfClose: () => cut((client) => client.end()),
    destroy: () => cut((client) => client.destroy()),
    setSilent: (on: boolean) => void (silent.on = on),
    silentAccepts: () => silent.accepted,
    close: () =>
      new Promise<void>((r) => {
        cut((client) => client.destroy());
        for (const client of silent.held) client.destroy();
        server.close(() => r());
      }),
  };
}

export type CutProxy = Awaited<ReturnType<typeof startCutProxy>>;
