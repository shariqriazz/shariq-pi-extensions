/**
 * Loaded with `-e` into a process-runtime subagent (`pi --mode rpc`). It keeps
 * the child inside its capability and carries the parent bridge tools over
 * Pi's RPC extension-UI subprotocol: notifications for one-way updates and
 * input dialogs for questions that need an answer. It is not a suite
 * extension and does nothing outside a child process.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CHILD_EXCLUDED_TOOL_NAMES } from "../../shared/child-session.ts";
import { childToolAllowed } from "./backends/pi.ts";
import type { CapabilityMode } from "./config.ts";
import { hideFusionSkill } from "./fusion.ts";

export const CHILD_ENV = "PI_SUBAGENT_CHILD";
export const CHILD_CAPABILITY_ENV = "PI_SUBAGENT_CAPABILITY";
export const CHILD_TOOLS_ENV = "PI_SUBAGENT_TOOLS";
export const CHILD_BRIDGE_ENV = "PI_SUBAGENT_BRIDGE";
/** Prefix that marks bridge traffic among ordinary extension UI requests. */
export const BRIDGE_MARK = "pi-subagent-bridge:";

export type BridgeRequest =
  | { kind: "notify"; message: string }
  | { kind: "ask"; question: string }
  | { kind: "peers" }
  | { kind: "peer"; id: string; message: string };

const excluded = new Set<string>(CHILD_EXCLUDED_TOOL_NAMES);

async function request(ctx: ExtensionContext, body: BridgeRequest, signal?: AbortSignal): Promise<string> {
  const reply = await ctx.ui.input(`${BRIDGE_MARK}${JSON.stringify(body)}`, "", { signal });
  if (reply === undefined) throw new Error("The parent session did not answer.");
  if (reply.startsWith("error:")) throw new Error(reply.slice("error:".length).trim());
  return reply;
}

export default function childBridge(pi: ExtensionAPI) {
  if (process.env[CHILD_ENV] !== "1") return;
  const capability = (process.env[CHILD_CAPABILITY_ENV] ?? "all") as CapabilityMode;
  const allowlist = process.env[CHILD_TOOLS_ENV] ? (JSON.parse(process.env[CHILD_TOOLS_ENV]!) as string[]) : undefined;
  const allowed = (name: string) => !excluded.has(name) && childToolAllowed(name, capability, allowlist);

  pi.on("tool_call", (event) =>
    allowed(event.toolName)
      ? undefined
      : { block: true, reason: `Tool "${event.toolName}" is not permitted for this subagent.` },
  );
  const restrict = () => {
    const active = pi.getActiveTools();
    const next = active.filter(allowed);
    if (next.length !== active.length) pi.setActiveTools(next);
  };
  pi.on("session_start", restrict);
  pi.on("agent_start", restrict);
  hideFusionSkill(pi);

  if (process.env[CHILD_BRIDGE_ENV] !== "1") return;
  pi.registerTool({
    name: "message_parent",
    label: "Message Parent",
    description: "Send the parent a concise non-blocking update or warning.",
    exposure: "model-only",
    parameters: Type.Object({ message: Type.String({ description: "Parent update" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      ctx.ui.notify(
        `${BRIDGE_MARK}${JSON.stringify({ kind: "notify", message: params.message } satisfies BridgeRequest)}`,
        "info",
      );
      return { content: [{ type: "text", text: "Update sent to parent." }], details: {} };
    },
  });
  pi.registerTool({
    name: "ask_parent",
    label: "Ask Parent",
    description: "Ask the parent a blocking question required to continue.",
    exposure: "model-only",
    parameters: Type.Object({ question: Type.String({ description: "Parent question" }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const reply = await request(ctx, { kind: "ask", question: params.question }, signal);
      return { content: [{ type: "text", text: `Parent reply:\n${reply}` }], details: {} };
    },
  });
  pi.registerTool({
    name: "list_peers",
    label: "List Peer Agents",
    description: "List sibling agents managed by the main thread. This cannot create agents.",
    exposure: "model-only",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const peers = JSON.parse(await request(ctx, { kind: "peers" }, signal)) as Array<{
        id: string;
        status: string;
        title: string;
      }>;
      const text = peers.length
        ? peers.map((peer) => `${peer.id}\t${peer.status}\t${peer.title}`).join("\n")
        : "No peer agents are currently tracked.";
      return { content: [{ type: "text", text }], details: { peers } };
    },
  });
  pi.registerTool({
    name: "message_peer",
    label: "Message Peer Agent",
    description:
      "Route a message to an existing sibling agent through the main-thread manager. This cannot create agents.",
    exposure: "model-only",
    parameters: Type.Object({
      id: Type.String({ description: "Target peer id from list_peers" }),
      message: Type.String({ description: "Message for the peer" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      await request(ctx, { kind: "peer", id: params.id, message: params.message }, signal);
      return { content: [{ type: "text", text: `Message sent to ${params.id}.` }], details: { id: params.id } };
    },
  });
}
