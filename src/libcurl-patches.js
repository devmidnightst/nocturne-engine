// umbrella: fixes for the websocket side of libcurl-transport 2.0.5.
//
// every proxied websocket goes through libcurl (with epoxy picked, engine.js
// still hands sockets to libcurl), so these decide how every socket closes.
// same rules as scramjet-patches.js: exact string swaps, each one has to match
// exactly once, and nothing applies on any other version.

import fs from "node:fs";
import path from "node:path";
import { packageDir } from "./packages.js";
import { applyPatches, stripSourceMap } from "./scramjet-patches.js";

export const LIBCURL_TRANSPORT_VERSION = "2.0.5";

export const LIBCURL_PATCHES = [
	{
		id: "ws-close-code",
		why: "a close frame from the server reached the page as code 0 with no reason, and the page's own ws.close(code, reason) came back as code 0 too. discord's qr login reads the remote auth gateway's close code (1000 done, 4003 expired) to decide what to do next. read the code and reason out of the close frame, and hand the page back the code it closed with.",
		edits: [
			{
				find: `            returned_data = full_data;
          }
        }
      } else if (result_code === 0 && result_closed) {
        this.cleanup();`,
				replace: `            returned_data = full_data;
          }
        }
      } else if (result_code === 0 && result_closed) {
        let close_size = _get_result_size(result_ptr);
        let close_data = Module.HEAPU8.subarray(data_ptr, data_ptr + close_size);
        this.close_code = close_size >= 2 ? (close_data[0] << 8) | close_data[1] : 1005;
        this.close_reason = close_size > 2 ? new TextDecoder().decode(close_data.subarray(2)) : "";
        this.cleanup();`,
			},
			{
				find: `      this.socket.onclose = () => {
        this.status = this.CLOSED;
        let close_event = new CloseEvent("close");`,
				replace: `      this.socket.onclose = () => {
        if (this.status === this.CLOSED) return;
        this.status = this.CLOSED;
        let close_event = new CloseEvent("close", { code: this.socket.close_code ?? 1005, reason: this.socket.close_reason ?? "", wasClean: true });`,
			},
			{
				find: `    close() {
      this.status = this.CLOSING;
      this.socket.close();
    }`,
				replace: `    close(code, reason) {
      if (this.status === this.CLOSED) return;
      this.status = this.CLOSING;
      this.socket.close_code ??= code ?? 1005;
      this.socket.close_reason ??= reason ?? "";
      this.socket.close();
    }`,
			},
		],
	},
	{
		id: "ws-close-frame",
		why: "ws.close() tore the connection down without sending a close frame, so the server saw an abnormal 1006 drop. send one first. libcurl.js can only send an empty one, so the server sees 1005 (no code) instead of the page's code.",
		find: `      _send_to_websocket(this.http_handle, data_ptr, data_len, is_text);
      _free(data_ptr);
    }
    close() {
      this.cleanup();
    }`,
		replace: `      _send_to_websocket(this.http_handle, data_ptr, data_len, is_text);
      _free(data_ptr);
    }
    close() {
      if (this.connected) _close_websocket(this.http_handle);
      this.cleanup();
    }`,
	},
	{
		id: "ws-dead-socket-closes",
		why: "when a socket died without a close frame (the server went away, the network dropped) or the handshake was refused, the page never got a close event. an open socket only fired error and a refused one fired nothing at all, so the page sat on a dead socket forever instead of reconnecting. that's discord's qr code going stale and the gateway sitting on 'connecting'. fire error then close 1006, like a browser does.",
		edits: [
			{
				find: `    cleanup(error = 0) {
      if (!this.connected)
        return;`,
				replace: `    cleanup(error = 0) {
      if (!this.connected) {
        if (error && !this.handshake_failed) {
          this.handshake_failed = true;
          error_msg(\`Websocket "\${this.url}" failed to connect with error code \${error}: \${get_error_str(error)}\`);
          try {
            super.close();
          } catch {}
          this.onerror(error);
        }
        return;
      }`,
			},
			{
				find: `      this.socket.onerror = (error) => {
        this.status = this.CLOSED;
        let error_event = new Event("error");
        this.dispatchEvent(error_event);
        this.onerror(error_event);
      };`,
				replace: `      this.socket.onerror = (error) => {
        if (this.status === this.CLOSED) return;
        this.status = this.CLOSED;
        let error_event = new Event("error");
        this.dispatchEvent(error_event);
        this.onerror(error_event);
        let close_event = new CloseEvent("close", { code: 1006, reason: "", wasClean: false });
        this.dispatchEvent(close_event);
        this.onclose(close_event);
      };`,
			},
		],
	},
];

function libcurlVersion() {
	const pkg = path.join(packageDir("@mercuryworkshop/libcurl-transport"), "package.json");
	return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
}

export function libcurlDistFile() {
	return path.join(packageDir("@mercuryworkshop/libcurl-transport"), "dist/index.mjs");
}

/**
 * returns { code, applied: string[], skipped: {id, reason}[] }
 */
export function buildPatchedLibcurl(source, version) {
	source ??= fs.readFileSync(libcurlDistFile(), "utf8");
	version ??= libcurlVersion();
	const applied = [];
	const skipped = [];
	if (version !== LIBCURL_TRANSPORT_VERSION) {
		return {
			code: source,
			applied,
			skipped: LIBCURL_PATCHES.map((p) => ({ id: p.id, reason: `bundle is not libcurl-transport ${LIBCURL_TRANSPORT_VERSION}` })),
		};
	}
	let code = applyPatches(source, LIBCURL_PATCHES, applied, skipped);
	code = `/* p8q2: ${applied.join(", ") || "none"} */\n` + stripSourceMap(code) + "\n";
	return { code, applied, skipped };
}
