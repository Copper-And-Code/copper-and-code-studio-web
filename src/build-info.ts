import type { UpstreamInfo } from './upstream.ts';

declare const __UPSTREAM__: UpstreamInfo;

/** The upstream release this build was made from, filled in by Vite (vite.config.ts). */
export const upstream: UpstreamInfo = __UPSTREAM__;

declare const __REPOSITORY__: string;

/** Where the source of this site is (scripts/site.mjs). */
export const repository: string = __REPOSITORY__;
