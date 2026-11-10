/** Browser snippet served at GET /snippet.js. Kept dependency free and ES5-friendly. */
export const SNIPPET = `(function () {
  var script = document.currentScript;
  var endpoint = (script && script.getAttribute("data-endpoint")) ||
    (script && script.src ? new URL(script.src).origin + "/events" : "/events");
  var requireConsent = script && script.getAttribute("data-require-consent") === "true";
  var consent = !requireConsent;
  var queue = [];
  var STANDARD = ["PageView","ViewContent","AddToCart","InitiateCheckout","Purchase","Lead","CompleteRegistration"];

  function cookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : undefined;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function fbc() {
    var c = cookie("_fbc");
    if (c) return c;
    var m = /[?&]fbclid=([^&#]+)/.exec(location.search);
    return m ? "fb.1." + Date.now() + "." + m[1] : undefined;
  }
  function send(payload) {
    var body = JSON.stringify(payload);
    try {
      fetch(endpoint, { method: "POST", headers: { "content-type": "text/plain" }, body: body, keepalive: true, credentials: "omit" })
        .catch(function () {});
    } catch (e) {}
  }
  function track(name, custom, user, opts) {
    opts = opts || {};
    var eventId = opts.eventId || uuid();
    if (!consent) { queue.push([name, custom, user, { eventId: eventId }]); return eventId; }
    if (window.fbq) {
      var method = STANDARD.indexOf(name) >= 0 ? "track" : "trackCustom";
      window.fbq(method, name, custom || {}, { eventID: eventId });
    }
    user = user || {};
    user.fbp = user.fbp || cookie("_fbp");
    user.fbc = user.fbc || fbc();
    send({
      event_name: name,
      event_id: eventId,
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: location.href,
      user: user,
      custom_data: custom || {}
    });
    return eventId;
  }
  window.capi = {
    track: track,
    consent: function (granted) {
      consent = !!granted;
      if (consent) { var q = queue; queue = []; q.forEach(function (a) { track(a[0], a[1], a[2], a[3]); }); }
      else queue = [];
    }
  };
  if (script && script.getAttribute("data-auto-pageview") === "true") track("PageView");
})();
`;
