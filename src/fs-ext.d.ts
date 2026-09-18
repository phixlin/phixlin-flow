declare module 'fs-ext' {
  export function flock(fd: number, operation: string, callback: (error: Error | null) => void): void
}
