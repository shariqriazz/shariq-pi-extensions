import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function exitAliasExtension(pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Alias for /quit",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
