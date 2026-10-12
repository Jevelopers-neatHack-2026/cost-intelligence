declare module 'node:crypto' {
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function createHmac(algorithm: 'sha256', key: string): { update(data: string): { digest(encoding: 'hex'): string } };
}
