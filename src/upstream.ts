export interface UpstreamInfo {
  /** The tag the submodule points to, or null when the commit carries no tag. */
  tag: string | null;
  commit: string;
  version: string;
}

/** The upstream release as shown to the user, e.g. "v0.7.0" or "0.7.0 (untagged a45a85f00f4e)". */
export function upstreamLabel(info: UpstreamInfo): string {
  return info.tag ?? `${info.version} (untagged ${info.commit})`;
}
