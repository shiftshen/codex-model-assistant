#!/opt/homebrew/bin/node
import http from "node:http";
import https from "node:https";

import { sanitizeResponsesPayload } from "./relay-transform.mjs";

const listenPort = Number.parseInt(process.env.DEEPSEEK_RELAY_PORT || "18792", 10);
const targetHost = "api.deepseek.com";

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const input = Buffer.concat(chunks);
    let output = input;
    if ((request.headers["content-type"] || "").includes("json") && input.length > 0) {
      try {
        output = Buffer.from(
          JSON.stringify(sanitizeResponsesPayload(JSON.parse(input.toString("utf8")))),
        );
      } catch {
        output = input;
      }
    }

    const headers = {
      ...request.headers,
      host: targetHost,
      "content-type": request.headers["content-type"] || "application/json",
    };
    delete headers["content-length"];
    delete headers["content-encoding"];

    const upstream = https.request(
      {
        method: request.method,
        host: targetHost,
        port: 443,
        path: request.url,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    });
    upstream.end(output);
  });
});

server.listen(listenPort, "127.0.0.1", () => {
  process.stdout.write(`DeepSeek relay listening on 127.0.0.1:${listenPort}\n`);
});
