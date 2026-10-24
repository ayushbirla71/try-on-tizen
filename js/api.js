/*
 * REST wrapper (XHR: works everywhere on Tizen, supports timeouts).
 * TV.api.request(method, path, { body, auth: true|false, timeout }) -> Promise<data>
 * The promise resolves with `json.data`; rejects with Error { status, code, message }.
 * status 0 = network error / timeout.
 */
(function () {
    var TV = window.TV = window.TV || {};

    function url(path) {
        return TV.config.baseUrl.replace(/\/+$/, '') + TV.config.apiBasePath + path;
    }

    function request(method, path, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            var done = false;
            function fail(status, code, message) {
                if (done) { return; }
                done = true;
                var err = new Error(message || 'Request failed');
                err.status = status;
                err.code = code || 'REQUEST_FAILED';
                if (status === 401 && opts.auth !== false) { TV.bus.emit('api:unauthorized', { path: path }); }
                reject(err);
            }
            try {
                xhr.open(method, url(path), true);
            } catch (e) {
                return fail(0, 'NETWORK', e.message);
            }
            xhr.timeout = opts.timeout || TV.config.apiTimeoutMs;
            xhr.setRequestHeader('Accept', 'application/json');
            // ngrok free tunnels answer browser requests with an HTML warning
            // page (ERR_NGROK_6024) unless this header is present. Harmless elsewhere.
            xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');
            if (opts.body !== undefined) { xhr.setRequestHeader('Content-Type', 'application/json'); }
            if (opts.auth !== false) {
                var token = TV.pairing && TV.pairing.token();
                if (token) { xhr.setRequestHeader('Authorization', 'Bearer ' + token); }
            }
            xhr.onload = function () {
                var json = null;
                try { json = JSON.parse(xhr.responseText); } catch (e) { /* not json */ }
                if (xhr.status >= 200 && xhr.status < 300 && json && json.success !== false) {
                    if (done) { return; }
                    done = true;
                    resolve(json.data);
                } else {
                    var e = json && json.error ? json.error : {};
                    fail(xhr.status, e.code, e.message || ('HTTP ' + xhr.status));
                }
            };
            xhr.onerror = function () { fail(0, 'NETWORK', 'Network error'); };
            xhr.ontimeout = function () { fail(0, 'TIMEOUT', 'Request timed out'); };
            xhr.onabort = function () { fail(0, 'ABORTED', 'Request aborted'); };
            try {
                xhr.send(opts.body !== undefined ? JSON.stringify(opts.body) : null);
            } catch (e2) {
                fail(0, 'NETWORK', e2.message);
            }
        });
    }

    TV.api = {
        url: url,
        request: request,
        get: function (path, opts) { return request('GET', path, opts); },
        post: function (path, body, opts) {
            opts = opts || {};
            opts.body = body === undefined ? {} : body;
            return request('POST', path, opts);
        }
    };
})();
