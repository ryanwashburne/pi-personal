import { connect, type Socket } from "node:net";

export type VncWebSocket = {
  send: (data: Buffer | Uint8Array) => void;
  close: () => void;
};

export type VncProxy = {
  write: (data: string | Buffer | ArrayBuffer | Uint8Array) => void;
  end: () => void;
};

export function attachVncWebSocket(ws: VncWebSocket, port: number): Promise<VncProxy> {
  return new Promise((resolve, reject) => {
    const tcp: Socket = connect({ host: "127.0.0.1", port });
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
    };

    tcp.once("connect", () => {
      settled = true;
      resolve({
        write(data) {
          if (tcp.destroyed) return;
          tcp.write(toBuffer(data));
        },
        end() {
          tcp.destroy();
        },
      });
    });
    tcp.on("data", (chunk: Buffer) => {
      try {
        ws.send(chunk);
      } catch {
        tcp.destroy();
      }
    });
    tcp.on("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
      ws.close();
    });
    tcp.on("close", () => {
      if (!settled) finish(new Error("vnc tcp closed before connect"));
      ws.close();
    });
  });
}

export function vncProtocolHeaders(request: Request): Record<string, string> | undefined {
  const raw = request.headers.get("sec-websocket-protocol");
  if (!raw) return undefined;
  const offered = raw.split(",").map((part) => part.trim().toLowerCase());
  const picked = offered.find((part) => part === "binary") ?? offered.find((part) => part === "base64");
  if (!picked) return undefined;
  return { "Sec-WebSocket-Protocol": picked };
}

export function toBuffer(data: string | Buffer | ArrayBuffer | Uint8Array): Buffer {
  if (typeof data === "string") return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
