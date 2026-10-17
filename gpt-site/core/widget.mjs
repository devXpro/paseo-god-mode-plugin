// The show_images view: an MCP Apps widget that ChatGPT renders under the tool result. It shows the
// images show_images put in its hidden _meta and, where the host takes images into the model's
// context, hands them to the model too. Self-contained: the default MCP Apps CSP (data: images,
// no network) is all it needs, so it loads nothing and calls nothing but its host.
//
// The host may deliver the result over the MCP Apps bridge (ui/notifications/tool-result) or, in
// ChatGPT, as window.openai.toolResponseMetadata; the widget looks in both.

export const IMAGES_WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #0a0a0a; color: #ececec; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif; }
  main { padding: 10px; }
  header { display: flex; align-items: baseline; gap: 8px; margin: 2px 2px 8px; }
  .title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { flex: none; color: #ffb020; font-variant-numeric: tabular-nums; }
  .shared { flex: none; margin-left: auto; color: #7a7a7a; font-size: 11px; }
  .strip { display: flex; gap: 8px; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; }
  .strip::-webkit-scrollbar { display: none; }
  figure { margin: 0; flex: 0 0 100%; scroll-snap-align: start; }
  img { display: block; width: 100%; max-height: 70vh; object-fit: contain; background: #121212; border-radius: 10px; cursor: zoom-in; }
  figcaption { margin: 6px 2px 0; color: #9a9a9a; font-size: 12px; }
  .empty { color: #9a9a9a; padding: 16px 4px; }
</style>
</head>
<body>
<main>
  <header><span class="title" id="title">Images</span><span class="count" id="count"></span><span class="shared" id="shared"></span></header>
  <div class="strip" id="strip"></div>
  <div class="empty" id="empty">Waiting for the images…</div>
</main>
<script>
(function () {
  var KEY = "god-mode/images";
  var TYPES = { "image/png": 1, "image/jpeg": 1, "image/webp": 1, "image/gif": 1 };
  var BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
  var pending = {};
  var nextId = 1;
  var host = null;
  var current = null;
  var sharedFor = null;

  function send(message) {
    window.parent.postMessage(message, "*");
  }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
    });
  }
  function notify(method, params) {
    send({ jsonrpc: "2.0", method: method, params: params });
  }

  // The tool result's hidden _meta, wherever this host put it.
  function find(value, depth) {
    if (!value || typeof value !== "object" || depth > 5) return null;
    if (value[KEY] && Array.isArray(value[KEY].images)) return value[KEY];
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var found = find(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  // Only what an image can be: a known type and base64 bytes. Everything else is dropped.
  function usable(images) {
    return images.filter(function (image) {
      return image && TYPES[image.mime] && typeof image.data === "string" && BASE64.test(image.data);
    });
  }

  function resize() {
    notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  }

  function fullscreen() {
    request("ui/request-display-mode", { mode: "fullscreen" }).catch(function () {
      if (window.openai && window.openai.requestDisplayMode) window.openai.requestDisplayMode({ mode: "fullscreen" });
    });
  }

  function render(payload) {
    var images = usable(payload.images);
    var chat = payload.chat || {};
    document.getElementById("title").textContent = chat.title ? chat.title + (chat.project ? " · " + chat.project : "") : "Images";
    document.getElementById("count").textContent = images.length > 1 ? images.length + " images" : "";
    var strip = document.getElementById("strip");
    strip.textContent = "";
    images.forEach(function (image, index) {
      var figure = document.createElement("figure");
      var img = document.createElement("img");
      img.alt = image.name || "image";
      img.onload = resize;
      img.onclick = fullscreen;
      img.src = "data:" + image.mime + ";base64," + image.data;
      var caption = document.createElement("figcaption");
      caption.textContent = (images.length > 1 ? index + 1 + "/" + images.length + " · " : "") + "turn " + image.turn + " · " + (image.name || "image");
      figure.appendChild(img);
      figure.appendChild(caption);
      strip.appendChild(figure);
    });
    var empty = document.getElementById("empty");
    empty.textContent = "No images to show.";
    empty.style.display = images.length ? "none" : "block";
    resize();
  }

  // Hands the images to the model where the host takes images into its context. A host that says it
  // does not (web) is left alone; one that does not say is asked, and may refuse.
  function share() {
    if (!host || !current || sharedFor === current) return;
    var images = usable(current.images);
    var context = host.updateModelContext;
    if (images.length === 0 || (context && !context.image)) return;
    sharedFor = current;
    var chat = current.chat || {};
    var content = [{ type: "text", text: "Images from the Paseo chat " + (chat.title || "") + " that the user is looking at, in order: " + images.map(function (i) { return "turn " + i.turn + " " + (i.name || "image"); }).join("; ") + "." }];
    images.forEach(function (image) {
      content.push({ type: "image", data: image.data, mimeType: image.mime });
    });
    request("ui/update-model-context", { content: content })
      .then(function () {
        document.getElementById("shared").textContent = "shared with ChatGPT";
      })
      .catch(function () {});
  }

  // A result without images (no image in the chat, or a question back) still ends the wait.
  function take(source) {
    if (!source) return;
    var payload = find(source, 0) || { images: [] };
    if (payload === current) return;
    current = payload;
    render(payload);
    share();
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending[message.id]) {
      var waiting = pending[message.id];
      delete pending[message.id];
      if (message.error) waiting.reject(message.error);
      else waiting.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") take(message.params);
  });
  window.addEventListener("openai:set_globals", function () {
    take(window.openai && window.openai.toolResponseMetadata);
  });

  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "god-mode-images", version: "1" }, appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } })
    .then(function (result) {
      host = (result && result.hostCapabilities) || {};
      notify("ui/notifications/initialized", {});
      share();
    })
    .catch(function () {
      host = {};
    });
  take(window.openai && window.openai.toolResponseMetadata);
})();
</script>
</body>
</html>
`;
