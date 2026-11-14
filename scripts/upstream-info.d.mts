export interface UpstreamInfo {
  tag: string | null;
  commit: string;
  version: string;
}
export function upstreamInfo(): UpstreamInfo;
