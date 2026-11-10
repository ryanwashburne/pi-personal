import { expect, test } from "bun:test";
import { createServer, type AddressInfo } from "node:net";
import { attachVncWebSocket, toBuffer, vncProtocolHeaders } from "./vnc-proxy";

test("vncProtocolHeaders echoes noVNC's binary subprotocol", () => {
  expect(vncProtocolHeaders(new Request("http://x", { headers: { "Sec-WebSocket-Protocol": "binary" } }))).toEqual({
    "Sec-WebSocket-Protocol": "binary",
  });
  expect(vncProtocolHeaders(new Request("http://x"))).toBeUndefined();
});

test("toBuffer accepts strings and byte arrays", () => {
  expect(toBuffer("ab").toString()).toBe("ab");
  expect(toBuffer(Buffer.from([1, 2]))[1]).toBe(2);
  expect(toBuffer(new Uint8Array([9]))[0]).toBe(9);
});

test("attachVncWebSocket pipes bytes to TCP and back", async () => {
  const server = createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const incoming: Buffer[] = [];
  let closed = false;
  const proxy = await attachVncWebSocket(
    {
      send(data) {
        incoming.push(Buffer.from(data));
      },
      close() {
        closed = true;
      },
    },
    port,
  );
  proxy.write("rfb");
  await waitFor(() => incoming.some((chunk) => chunk.toString().includes("rfb")));
  expect(incoming[0].toString()).toContain("rfb");
  proxy.end();
  await waitFor(() => closed);
  server.close();
});

function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}
