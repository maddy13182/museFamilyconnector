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
  export function readdirSync(path: string): string[];
}

declare module 'node:path' {
  export function dirname(p: string): string;
  export function join(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
