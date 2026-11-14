import type { UpstreamInfo } from './upstream.ts';

declare const __UPSTREAM__: UpstreamInfo;

/** The upstream release this build was made from, filled in by Vite (vite.config.ts). */
export const upstream: UpstreamInfo = __UPSTREAM__;
