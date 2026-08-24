import WebSocket, { type RawData } from "ws";

const FACTORY_DROID_MARKER = "You are Droid, an AI software engineering agent built by Factory.";

export interface FactoryWebSocketFetchOptions {
	apiKey: string;
	assistantMessageId: string;
	headers: Record<string, string>;
}

export function factoryResponsesWebSocketUrl(httpUrl: string): string {
	const url = new URL(httpUrl);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
	return url.toString();
}

export function prepareFactoryResponsesWebSocketPayload(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new Error("Factory Responses request body must be a JSON object");
	}

	const payload = { ...(body as Record<string, unknown>) };
	const input = Array.isArray(payload.input) ? [...payload.input] : [];
	const first = input[0];
	if (first && typeof first === "object" && !Array.isArray(first)) {
		const message = first as Record<string, unknown>;
		if (
			(message.role === "developer" || message.role === "system") &&
			typeof message.content === "string" &&
			message.content.includes(FACTORY_DROID_MARKER)
		) {
			payload.instructions = message.content;
			input.shift();
			payload.input = input;
		}
	}

	payload.parallel_tool_calls ??= true;
	payload.tool_choice ??= "auto";
	return { type: "response.create", ...payload };
}

/** Adapt Factory's Responses WebSocket transport to the Fetch/SSE interface used by pi-ai. */
export function createFactoryResponsesWebSocketFetch(options: FactoryWebSocketFetchOptions): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const requestUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
		const bodyText = typeof init?.body === "string" ? init.body : await new Request(input, init).text();
		const payload = prepareFactoryResponsesWebSocketPayload(JSON.parse(bodyText));
		payload._factory = { assistantMessageId: options.assistantMessageId };
		const responseStream = new TransformStream<Uint8Array, Uint8Array>();
		const writer = responseStream.writable.getWriter();
		const encoder = new TextEncoder();

		return await new Promise<Response>((resolve, reject) => {
			let opened = false;
			let settled = false;
			const socket = new WebSocket(factoryResponsesWebSocketUrl(requestUrl), {
				headers: {
					...options.headers,
					Authorization: `Bearer ${options.apiKey}`,
				},
			});

			const abort = () => {
				init?.signal?.removeEventListener("abort", abort);
				try {
					socket.close();
				} catch {
					// Ignore socket close errors during abort.
				}
				void writer.abort(init?.signal?.reason || new Error("Factory request was aborted")).catch(() => undefined);
				if (!settled) {
					settled = true;
					reject(init?.signal?.reason || new Error("Factory request was aborted"));
				}
			};

			if (init?.signal?.aborted) {
				abort();
				return;
			}
			init?.signal?.addEventListener("abort", abort, { once: true });

			socket.once("open", () => {
				opened = true;
				settled = true;
				socket.send(JSON.stringify(payload));
				resolve(
					new Response(responseStream.readable, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
				);
			});

			socket.on("message", (data: RawData) => {
				const text = data.toString();
				void writer.write(encoder.encode(`data: ${text}\n\n`)).catch(() => undefined);
				try {
					const event = JSON.parse(text) as { type?: string };
					if (event.type === "response.completed" || event.type === "response.failed" || event.type === "error") {
						void writer.close().catch(() => undefined);
						socket.close();
					}
				} catch {
					// Let pi-ai report malformed provider events through its normal parser.
				}
			});

			socket.once("unexpected-response", (_request, response) => {
				init?.signal?.removeEventListener("abort", abort);
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					settled = true;
					resolve(
						new Response(Buffer.concat(chunks), {
							status: response.statusCode ?? 500,
							statusText: response.statusMessage,
							headers: response.headers as HeadersInit,
						}),
					);
				});
			});

			socket.once("error", (error) => {
				init?.signal?.removeEventListener("abort", abort);
				if (!settled) {
					settled = true;
					reject(error);
				} else if (opened) {
					void writer.abort(error).catch(() => undefined);
				}
			});
			socket.once("close", () => {
				init?.signal?.removeEventListener("abort", abort);
				if (opened) void writer.close().catch(() => undefined);
			});
		});
	}) as typeof fetch;
}
