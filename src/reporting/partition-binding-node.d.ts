/** Narrow Node22 declarations, not proof of issuer custody or transaction ownership. */
declare module 'node:sqlite' {
  type SQLValue = string | number | bigint | null | Uint8Array;
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; enableForeignKeyConstraints?: boolean });
    readonly isTransaction: boolean;
    exec(sql: string): void;
    prepare(sql: string): {
      get(...values: SQLValue[]): Record<string, unknown> | undefined;
      all(...values: SQLValue[]): Record<string, unknown>[];
      run(...values: SQLValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
    close(): void;
  }
}
declare module 'node:crypto' {
  export function createPublicKey(options: { key: Uint8Array; format: 'der'; type: 'spki' }): { readonly asymmetricKeyType?: string };
  export function verify(algorithm: null, data: Uint8Array, key: { readonly asymmetricKeyType?: string }, signature: Uint8Array): boolean;
  export function createHash(algorithm: 'sha256', options: { outputLength?: never }): { update(data: Uint8Array): { digest(encoding: 'hex'): string }; update(data: string, encoding?: 'utf8'): { digest(encoding: 'hex'): string } };
}
