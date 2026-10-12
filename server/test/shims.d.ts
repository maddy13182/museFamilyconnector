// Minimal ambient declarations for the node: builtins used in tests.
// Lets tsc compile without @types/node, keeping `typescript` the single
// dev dependency. Runtime behavior comes from Node itself.

declare module 'node:test' {
  export function test(name: string, fn: (t: unknown) => void | Promise<void>): void;
}

declare module 'node:assert' {
  const assert: {
    (value: unknown, message?: string): void;
    equal(a: unknown, b: unknown, message?: string): void;
    notEqual(a: unknown, b: unknown, message?: string): void;
    deepEqual(a: unknown, b: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    fail(message?: string): never;
    match(s: string, re: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
  };
  export default assert;
}

declare module 'node:assert/strict' {
  import assert from 'node:assert';
  export default assert;
}

declare module 'node:sqlite' {
  export interface StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
  export function readFileSync(path: string): Uint8Array;
  export function readdirSync(path: string): string[];
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Uint8Array;
}

declare module 'node:child_process' {
  export interface ExecFileError {
    code?: number | string | null;
    message: string;
  }
  export function execFile(
    file: string,
    args: string[],
    options: { env?: Record<string, string | undefined>; timeout?: number },
    callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
  ): void;
}

declare module 'node:http' {
  export interface IncomingMessage {
    url?: string;
  }
  export interface ServerResponse {
    writeHead(statusCode: number): void;
    end(body?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, hostname: string, callback: () => void): void;
    close(callback: (err?: unknown) => void): void;
    address(): { port: number } | null;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}

// Tests run under Node; the worker source never touches this.
declare const process: {
  execPath: string;
  env: Record<string, string | undefined>;
};

declare module 'node:path' {
  export function dirname(p: string): string;
  export function join(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
