// Types for scripts/deb-version.mjs, which the main process imports (src/main/update-install.ts).
export declare function debVersionParts(version: string): { upstream: string; revision: string }
export declare function debVersionOf(version: string): string
