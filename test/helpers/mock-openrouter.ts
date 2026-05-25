import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockHandler {
  (req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> | void;
}

export interface MockServer {
  port: number;
  baseUrl: string;
  close(): Promise<void>;
  requests: { method: string; url: string; body: string; headers: Record<string, string | string[] | undefined> }[];
}

export async function startMockOpenRouter(handler: MockHandler): Promise<MockServer> {
  const requests: MockServer['requests'] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        body: body.toString('utf8'),
        headers: req.headers,
      });
      Promise.resolve(handler(req, res, body)).catch((err: unknown) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function jsonResponse(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function chatSuccessBody(content = 'hello'): Record<string, unknown> {
  return {
    id: 'gen-test-' + Math.random().toString(36).slice(2),
    model: 'mock/model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}
