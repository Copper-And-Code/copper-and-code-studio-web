export interface UpstreamInfo {
  tag: string | null;
  commit: string;
  version: string;
  website: string;
}
export function upstreamInfo(): UpstreamInfo;
