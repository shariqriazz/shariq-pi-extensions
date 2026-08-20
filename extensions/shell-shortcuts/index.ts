import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import exitAliasExtension from "./features/exit-alias.ts";

export default function qolExtension(pi: ExtensionAPI) {
  exitAliasExtension(pi);
}
