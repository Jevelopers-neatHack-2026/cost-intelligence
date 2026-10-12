/** Minimal Node 22 filesystem declarations; the package deliberately has no @types/node dependency. */
declare module 'node:fs' {
  export const constants: { O_RDONLY: number; O_WRONLY: number; O_CREAT: number; O_EXCL: number; O_NOFOLLOW: number };
}
declare module 'node:fs/promises' {
  type Stats = { size: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };
  type FileHandle = {
    stat(): Promise<Stats>; readFile(encoding: 'utf8'): Promise<string>;
    writeFile(data: string, encoding: 'utf8'): Promise<void>; sync(): Promise<void>; close(): Promise<void>;
  };
  export function lstat(path: string): Promise<Stats>;
  export function mkdir(path: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
  export function open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  export function link(existingPath: string, newPath: string): Promise<void>;
  export function unlink(path: string): Promise<void>;
}
declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}
declare module 'node:crypto' {
  type Hmac = { update(data: string, encoding: 'utf8'): Hmac; digest(encoding: 'hex'): string };
  export function createHmac(algorithm: 'sha256', key: Uint8Array): Hmac;
  export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean;
}
declare module 'node:util' { export const types: { isProxy(value: unknown): boolean }; }
