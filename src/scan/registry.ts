type ScanFn = (text: string) => Promise<unknown>;

const scanFns = new Map<string, ScanFn>();

export function registerScanFn(name: string, fn: ScanFn): void {
  scanFns.set(name, fn);
}

export function getScanFn(name: string): ScanFn | undefined {
  return scanFns.get(name);
}

export function listScanFns(): string[] {
  return [...scanFns.keys()];
}
