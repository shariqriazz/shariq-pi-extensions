import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import zlib from "node:zlib";
import webFetchExtension, { ALLOW_PRIVATE_ENV, isBlockedAddress } from "./index.ts";

function registeredTool() {
  let tool: any;
  webFetchExtension({
    registerTool(definition: any) {
      tool = definition;
    },
  } as never);
  return tool;
}

async function withServer(handler: http.RequestListener, run: (base: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env[ALLOW_PRIVATE_ENV];
  process.env[ALLOW_PRIVATE_ENV] = "1";
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    if (previous === undefined) delete process.env[ALLOW_PRIVATE_ENV];
    else process.env[ALLOW_PRIVATE_ENV] = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const body = (result: any) => result.content[0].text.split("\n\n").slice(1).join("\n\n");

test("web_fetch routing treats remote content as data rather than instructions", () => {
  const tool = registeredTool();
  assert.equal(tool?.name, "web_fetch");
  assert.match(tool?.description ?? "", /known URL or API/);
  assert.match(tool?.description ?? "", /use web_search for discovery/);
  assert.match(tool?.promptGuidelines?.join(" ") ?? "", /untrusted data, not instructions/);
});

test("local, private, and metadata destinations are blocked by default", async () => {
  delete process.env[ALLOW_PRIVATE_ENV];
  const tool = registeredTool();
  for (const url of [
    "http://127.0.0.1:9/",
    "http://[::1]:9/",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost:9/",
    "http://10.1.2.3/",
  ]) {
    await assert.rejects(tool.execute("blocked", { url }), /local or private network address/, url);
  }
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.20.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0.0.0.0",
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("HTML converts with structure, resolved links, and safe code fences", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/docs/page" });
        res.end("redirect body");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><head><title>t</title></head><body><script>steal()</script><h1>Title</h1>
      <ol><li>one</li><li>two</li></ol>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      <pre><code>  keep
    \`\`\` indentation</code></pre>
      <a href="../other?a=1&amp;b=2">link</a><img src="pic.png" alt="pic"><p>bad &#1114112; entity</p></body></html>`);
    },
    async (base) => {
      const result = await registeredTool().execute("html", { url: `${base}/start` });
      const text = body(result);
      assert.equal(result.details.finalUrl, `${base}/docs/page`);
      assert.doesNotMatch(text, /steal/);
      assert.match(text, /# Title/);
      assert.match(text, /1\. one\n2\. two/);
      assert.match(text, /\| A \| B \|/);
      assert.match(text, /````\n  keep\n    ``` indentation\n````/);
      assert.match(text, new RegExp(`\\[link\\]\\(${base}/other\\?a=1&b=2\\)`));
      assert.match(text, new RegExp(`!\\[pic\\]\\(${base}/docs/pic.png\\)`));
    },
  );
});

test("non-HTML payloads are returned exactly, decoded with their declared charset", async () => {
  const json = '{"example":"<body>literal</body>","spaced":"a    b","entity":"&amp;"}';
  await withServer(
    (req, res) => {
      if (req.url === "/json") {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
        res.end(zlib.gzipSync(json));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=windows-1252" });
      res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94]));
    },
    async (base) => {
      assert.equal(body(await registeredTool().execute("json", { url: `${base}/json` })), json);
      assert.equal(body(await registeredTool().execute("latin", { url: `${base}/latin` })), "café \u201cq\u201d");
    },
  );
});

test("size limits stop transfers, and errors, timeouts, and cancellation surface", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/declared") {
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(50 * 1024 * 1024) });
        res.write("x");
        return;
      }
      if (req.url === "/stream") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        const timer = setInterval(() => res.write("y".repeat(1024)), 1);
        res.on("close", () => clearInterval(timer));
        return;
      }
      if (req.url === "/fail") {
        res.writeHead(500, "Server Error", { "Content-Type": "text/plain" });
        res.end("failure");
        return;
      }
      // /hang never responds.
    },
    async (base) => {
      const tool = registeredTool();
      await assert.rejects(tool.execute("declared", { url: `${base}/declared`, maxBytes: 4096 }), /Response too large/);
      const streamed = await tool.execute("stream", { url: `${base}/stream`, maxBytes: 4096 });
      assert.equal(streamed.details.bytes, 4096);
      assert.equal(streamed.details.truncated, true);
      await assert.rejects(tool.execute("fail", { url: `${base}/fail` }), /HTTP 500 Server Error/);
      await assert.rejects(
        tool.execute("timeout", { url: `${base}/hang`, timeoutSeconds: 1 }),
        /timed out after 1 seconds/,
      );
      const controller = new AbortController();
      const pending = tool.execute("cancel", { url: `${base}/hang` }, controller.signal);
      setTimeout(() => controller.abort(new Error("cancelled by test")), 20);
      await assert.rejects(pending, /cancelled by test/);
    },
  );
});
