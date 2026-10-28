/*
 * Socket.IO link to the backend's /display namespace.
 * Emits on TV.bus:  'state' (display:state, rev-filtered), 'ads:updated', 'settings:updated',
 *                   'display:approved', 'socket:connected', 'socket:down', 'socket:authFailed'.
 */
(function () {
    var TV = window.TV = window.TV || {};

    var sock = null;
    var connected = false;
    var hbTimer = null;
    var retryTimer = null;
    var retryAttempt = 0;
    var lastRev = -1;
    var lastDisplayId = null;

    function stopHeartbeat() {
        if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    }

    function sendHeartbeat() {
        if (sock && connected) { sock.emit('display:heartbeat'); }
    }

    function startHeartbeat() {
        stopHeartbeat();
        sendHeartbeat();
        hbTimer = setInterval(sendHeartbeat, TV.config.heartbeatMs);
    }

    function applyState(s) {
        if (!s || typeof s !== 'object') { return; }
        var own = TV.pairing.displayId();
        if (s.displayId && own && s.displayId !== own) { return; }
        if (s.displayId !== lastDisplayId) { lastDisplayId = s.displayId; lastRev = -1; }
        if (typeof s.rev === 'number') {
            if (s.rev < lastRev) { TV.log('ignoring stale state rev', s.rev, '<', lastRev); return; }
            lastRev = s.rev;
        }
        TV.bus.emit('state', s);
    }

    // socket.io does not retry on its own after a middleware rejection or a server-initiated
    // disconnect, so do it here with exponential backoff.
    function scheduleManualRetry() {
        if (retryTimer || !sock) { return; }
        var delay = TV.backoff(retryAttempt++, 1000, 20000);
        TV.log('socket retry in', delay, 'ms');
        retryTimer = setTimeout(function () {
            retryTimer = null;
            if (sock && !sock.connected) { sock.connect(); }
        }, delay);
    }

    TV.socket = {
        isConnected: function () { return connected; },

        /** (Re)open the connection using the current token. */
        connect: function () {
            TV.socket.disconnect();
            if (typeof window.io !== 'function') { TV.log('socket.io client missing'); return; }
            if (!TV.pairing.token()) { return; }
            sock = window.io(TV.config.baseUrl.replace(/\/+$/, '') + '/display', {
                path: TV.config.socketPath,
                transports: ['websocket'],
                // function form: every (re)connect attempt picks up a rotated token
                auth: function (cb) { cb({ token: TV.pairing.token() }); },
                reconnection: true,
                reconnectionAttempts: Infinity,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 15000,
                randomizationFactor: 0.5,
                timeout: 10000
            });
            var mine = sock;

            mine.on('connect', function () {
                if (mine !== sock) { return; }
                connected = true;
                retryAttempt = 0;
                // The server pushes the current state right after connect; accept it whatever
                // its rev (a Redis flush on the server could have reset the counter).
                lastRev = -1;
                TV.log('socket connected');
                startHeartbeat();
                TV.bus.emit('socket:connected');
            });

            mine.on('disconnect', function (reason) {
                if (mine !== sock) { return; }
                connected = false;
                stopHeartbeat();
                TV.log('socket disconnected:', reason);
                TV.bus.emit('socket:down', { reason: reason });
                if (reason === 'io server disconnect') { scheduleManualRetry(); }
            });

            mine.on('connect_error', function (err) {
                if (mine !== sock) { return; }
                connected = false;
                var msg = (err && err.message) || '';
                TV.log('socket connect_error:', msg);
                TV.bus.emit('socket:down', { reason: msg });
                if (/token|unauthor/i.test(msg)) {
                    TV.bus.emit('socket:authFailed', { message: msg });
                } else if (!mine.active) {
                    scheduleManualRetry();
                }
            });

            mine.on('display:state', function (s) { if (mine === sock) { applyState(s); } });
            mine.on('ads:updated', function (p) { TV.bus.emit('ads:updated', p); });
            mine.on('settings:updated', function (p) { TV.bus.emit('settings:updated', p); });
            mine.on('display:approved', function (p) { TV.bus.emit('display:approved', p); });
            // an administrator took this TV back from its client (admin panel -> Devices -> Disconnect)
            mine.on('display:disconnected', function (p) { if (mine === sock) { TV.bus.emit('display:disconnected', p); } });
        },

        disconnect: function () {
            stopHeartbeat();
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            connected = false;
            if (sock) {
                var old = sock;
                sock = null;
                try { old.removeAllListeners(); old.close(); } catch (e) { /* ignore */ }
            }
        },

        /**
         * Remote key -> server. Resolves with the ack; rejects with Error{code,message}.
         * The UI is NOT changed here: the server answers with display:state to everyone.
         */
        sendKey: function (dir) {
            return new Promise(function (resolve, reject) {
                if (!sock || !connected) {
                    var e = new Error('Not connected');
                    e.code = 'OFFLINE';
                    return reject(e);
                }
                sock.timeout(5000).emit('display:key', { dir: dir }, function (err, res) {
                    if (err) {
                        var te = new Error('Server did not answer');
                        te.code = 'TIMEOUT';
                        return reject(te);
                    }
                    if (res && res.ok) {
                        // Same server-authoritative state the broadcast carries; the rev filter dedupes it.
                        if (res.state) { applyState(res.state); }
                        return resolve(res);
                    }
                    var ae = new Error((res && res.message) || 'Rejected');
                    ae.code = (res && res.code) || 'REJECTED';
                    reject(ae);
                });
            });
        }
    };
})();
