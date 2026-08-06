import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type E2StubResponseMode =
  | 'valid200'
  | 'malformed200'
  | 'wrongName200'
  | '404'
  | '400'
  | '401'
  | '403'
  | '429'
  | '500'
  | 'hang'
  | 'closeConnection'
  | 'custom';

export interface E2StubLastRequest {
  method: string | undefined;
  /** Path + query string exactly as received (e.g. includes `?mask.fieldPaths=...`). */
  url: string | undefined;
  authorization: string | undefined;
}

export interface E2StubServerHandle {
  readonly baseUrl: string;
  readonly port: number;
  setMode(mode: E2StubResponseMode): void;
  /** Serves `body` (JSON-stringified) with `status` while mode is 'custom'. */
  setCustomBody(body: unknown, status?: number): void;
  getRequestCount(): number;
  /** R4-F5 (Remediation-5) — safe, non-body request metadata for exact method/path/mask/auth assertions. */
  getLastRequest(): E2StubLastRequest | null;
  close(): Promise<void>;
}

function validShiftCloseCaseBody(): unknown {
  return {
    name: 'projects/twinpet-pos/databases/pos-db/documents/shiftCloseCases/test-shift',
    fields: {
      processingState: { stringValue: 'validated' },
      settlementState: { stringValue: 'unsettled' },
      alertState: { stringValue: 'none' },
      caseVersion: { integerValue: '3' },
      latestEvidenceId: { stringValue: 'ev-1' },
      latestCloseHash: { stringValue: 'hash-1' },
    },
  };
}

function malformedShiftCloseCaseBody(): unknown {
  // Passes JSON.parse but fails the document-level shape check (`fields`
  // must be a non-array plain object) — a whole-body malformation, not just
  // one field's wrapper, so it must surface as malformed_200_body rather
  // than a per-field MALFORMED with the document staying EXISTS.
  return {
    name: 'projects/twinpet-pos/databases/pos-db/documents/shiftCloseCases/test-shift',
    fields: [],
  };
}

function wrongNameShiftCloseCaseBody(): unknown {
  return {
    name: 'projects/twinpet-pos/databases/pos-db/documents/shiftCloseCases/some-other-shift',
    fields: {
      processingState: { stringValue: 'validated' },
    },
  };
}

/**
 * Loopback-only (127.0.0.1, ephemeral port) HTTP stub standing in for the
 * Firestore REST document-get endpoint. Never binds anything but loopback;
 * never proxies to a real host. Response shape is switched per-test via
 * setMode() so a single server instance can be reused across assertions.
 */
export function startE2StubServer(): Promise<E2StubServerHandle> {
  return new Promise((resolve, reject) => {
    let mode: E2StubResponseMode = 'valid200';
    let customBody: unknown = {};
    let customStatus = 200;
    let requestCount = 0;
    let lastRequest: E2StubLastRequest | null = null;
    const hangingResponses: http.ServerResponse[] = [];

    const server = http.createServer((req, res) => {
      requestCount += 1;
      lastRequest = { method: req.method, url: req.url, authorization: req.headers['authorization'] };
      switch (mode) {
        case 'valid200':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(validShiftCloseCaseBody()));
          break;
        case 'malformed200':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(malformedShiftCloseCaseBody()));
          break;
        case 'wrongName200':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(wrongNameShiftCloseCaseBody()));
          break;
        case 'custom':
          res.writeHead(customStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(customBody));
          break;
        case '404':
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 404, message: 'not found' } }));
          break;
        case '400':
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 400, message: 'bad request' } }));
          break;
        case '401':
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 401, message: 'unauthenticated' } }));
          break;
        case '403':
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 403, message: 'forbidden' } }));
          break;
        case '429':
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 429, message: 'rate limited' } }));
          break;
        case '500':
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 500, message: 'internal' } }));
          break;
        case 'hang':
          // Never respond; kept open so a signal test can observe a real
          // blocked direct child. Tracked for deterministic teardown.
          hangingResponses.push(res);
          break;
        case 'closeConnection':
          req.socket.destroy();
          break;
        default: {
          const exhaustiveCheck: never = mode;
          throw new Error(`unhandled stub mode: ${String(exhaustiveCheck)}`);
        }
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        port: address.port,
        setMode(next: E2StubResponseMode) {
          mode = next;
        },
        setCustomBody(body: unknown, status = 200) {
          customBody = body;
          customStatus = status;
        },
        getRequestCount() {
          return requestCount;
        },
        getLastRequest() {
          return lastRequest;
        },
        close() {
          for (const res of hangingResponses.splice(0)) {
            if (!res.writableEnded) {
              res.end();
            }
          }
          return new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          });
        },
      });
    });
  });
}
