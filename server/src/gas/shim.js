/* google.script.* for a client page served by our backend instead of Apps Script.
   google.script.run.withSuccessHandler(ok).withFailureHandler(fail).withUserObject(u).<fn>(…args)
   → POST /api/<module>/call/<fn> {args} → ok(result, u) | fail(Error(message), u). Loaded before the page's own scripts. */
(function () {
  var mod = document.currentScript.getAttribute('data-module');
  function send(name, args, ok, fail, user) {
    fetch('/api/' + mod + '/call/' + encodeURIComponent(name), {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-flow-request': '1' },
      body: JSON.stringify({ args: args })
    })
      .then(function (r) { return r.json().catch(function () { return { error: 'The server did not answer (' + r.status + ').' }; }); },
            function () { return { error: 'No connection to the server.' }; })
      .then(function (j) {
        if (j && 'result' in j) { if (ok) ok(j.result, user); return; }
        var e = new Error((j && j.error) || 'Request failed.');
        if (fail) fail(e, user); else console.error(e);
      });
  }
  function runner(ok, fail, user) {
    return new Proxy({}, {
      get: function (_t, name) {
        if (typeof name !== 'string' || name === 'then') return undefined;
        if (name === 'withSuccessHandler') return function (f) { return runner(f, fail, user); };
        if (name === 'withFailureHandler') return function (f) { return runner(ok, f, user); };
        if (name === 'withUserObject') return function (u) { return runner(ok, fail, u); };
        return function () { send(name, Array.prototype.slice.call(arguments), ok, fail, user); };
      }
    });
  }
  function location_() {
    var one = {}, all = {};
    new URLSearchParams(window.location.search).forEach(function (v, k) { (all[k] = all[k] || []).push(v); if (!(k in one)) one[k] = v; });
    return { hash: window.location.hash.replace(/^#/, ''), parameter: one, parameters: all };
  }
  var noop = function () {};
  window.google = window.google || {};
  window.google.script = {
    run: runner(null, null, undefined),
    url: { getLocation: function (cb) { cb(location_()); } },
    host: { close: noop, setHeight: noop, setWidth: noop, editor: { focus: noop } },
    history: { push: noop, replace: noop, setChangeHandler: noop }
  };
})();
