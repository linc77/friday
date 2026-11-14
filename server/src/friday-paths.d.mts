export type FridayPathOptions = { home?: string; env?: Record<string, string | undefined> };
export type FridayPaths = { root: string; data: string; workspace: string; logs: string; legacy: string; adoptLegacy: boolean };
export function fridayPaths(options?: FridayPathOptions): FridayPaths;
export function existingFridayData(options?: FridayPathOptions): string;
export function prepareFridayPaths(options?: FridayPathOptions): Promise<FridayPaths>;
export function personalWorkspaceDefault(directory: string, options?: FridayPathOptions): string;
