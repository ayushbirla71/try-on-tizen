/*
 * Wiring + state machine.
 *
 *   BOOT -> PAIRING (until the admin approves) -> ADS <-> RESULTS
 *
 * ADS vs RESULTS is driven ONLY by display:state.mode from the server (the single source of
 * truth). The one local exception is the idle fallback (idle.js), and any later display:state
 * overrides it.
 */
(function () {
    var TV = window.TV = window.TV || {};

    var approved = false;
    var serverState = null;      // last accepted display:state
    var localOverride = false;   // idle fallback forced ADS locally
    var recovering = false;
    var downTimer = null;
    var booted = false;
    var wasDisconnected = false;   // an administrator disconnected this TV (shown on the pairing screen)

    // ------------------------------------------------------------ view selection
    function applyView() {
        if (!approved) {
            TV.ads.stop();
            TV.results.hide();
            TV.idle.disarm();
            TV.ui.showScreen('pairing');
            return;
        }
        var s = serverState;
        var wantResults = !!(s && s.mode === 'RESULTS' && s.items && s.items.length && !localOverride);
        if (wantResults) {
            TV.ads.stop();
            TV.ui.showScreen('results');
            TV.results.render(s.items, s.index || 0);
            if (!TV.idle.isArmed()) { TV.idle.arm(); }
        } else {
            TV.results.hide();
            TV.idle.disarm();
            TV.ui.showScreen('ads');
            TV.ads.start();
        }
    }

    function setApproved(value) {
        if (value === approved) { return; }
        approved = value;
        TV.log('approved =', approved);
        TV.pairing.startPolling(approved ? TV.config.configPollMs : TV.config.pairingPollMs);
        if (approved) { TV.ads.enable(); } else { TV.ads.disable(); }
        applyView();
    }

    function applySettings(settings) {
        if (settings && settings.idleTimeoutSeconds) { TV.idle.setTimeoutSeconds(settings.idleTimeoutSeconds); }
        // null / missing = no colour configured: results sit on black while loading
        if (settings) { TV.results.setBackground(settings.backgroundColor); }
        // "Scan to download" QR on the result screen (off unless the admin turned it on)
        if (settings) { TV.results.setQr(settings.qrEnabled, settings.qrPosition); }
    }

    // ------------------------------------------------------------ registration / pairing
    function pairingFooter() {
        var duid = TV.pairing.duid();
        return 'Server: ' + TV.config.baseUrl + '   |   Device: ' + (duid.length > 12 ? '...' + duid.slice(-10) : duid);
    }

    function showPairingInfo(code, isApproved) {
        if (isApproved) { wasDisconnected = false; }
        TV.ui.setPairing({
            code: code,
            status: isApproved
                ? 'Connected - waiting to be linked to a kiosk'
                : (wasDisconnected ? 'Disconnected by your administrator' : 'Waiting to be connected to a client'),
            statusOk: !!isApproved,
            hint: isApproved
                ? 'Your administrator needs to link this screen to a kiosk.'
                : 'In your admin panel open Devices, choose Add a TV and enter the code above.'
        });
    }

    function isReady(cfgLike) {
        return !!cfgLike.approved && (!TV.config.requireLinkBeforeAds || !!cfgLike.linked);
    }

    function onRegistered(data) {
        TV.log('registered, approved =', data.approved);
        TV.ui.setPairing({ footer: pairingFooter() });
        showPairingInfo(data.pairingCode, data.approved);
        TV.socket.connect();                      // token may have rotated
        TV.pairing.startPolling(isReady(data) ? TV.config.configPollMs : TV.config.pairingPollMs);
        if (isReady(data)) {
            approved = false;                     // force the transition side effects in setApproved
            setApproved(true);
        } else {
            setApproved(false);
            applyView();
        }
    }

    function registerWithRetry(attempt) {
        TV.pairing.register().then(function (data) {
            onRegistered(data);
        }, function (err) {
            TV.log('register failed:', err.status, err.message);
            if (TV.pairing.hasCredentials()) {
                // Offline start: keep using the stored token; config polling / socket will sort it out.
                TV.ui.setPairing({ footer: pairingFooter(), code: TV.pairing.pairingCode() });
                TV.socket.connect();
                if (TV.pairing.wasApproved()) {
                    TV.pairing.startPolling(TV.config.configPollMs);
                    setApproved(true);
                } else {
                    TV.ui.setPairing({ status: 'Connecting to server...', statusOk: false });
                    TV.pairing.startPolling(TV.config.pairingPollMs);
                }
                return;
            }
            TV.ui.setPairing({
                status: 'Cannot reach the server - retrying...',
                statusOk: false,
                hint: 'Check the TV network connection and the backend address below.',
                footer: pairingFooter()
            });
            setTimeout(function () { registerWithRetry(attempt + 1); }, TV.backoff(attempt, 2000, 30000));
        });
    }

    // Token rejected (401 / socket auth failure): register again and reconnect.
    function recover() {
        if (recovering) { return; }
        recovering = true;
        TV.log('credentials rejected -> re-registering');
        TV.pairing.register().then(function (data) {
            recovering = false;
            onRegistered(data);
        }, function () {
            recovering = false;
            setTimeout(recover, 10000);
        });
    }

    // ------------------------------------------------------------ event wiring
    function wire() {
        TV.bus.on('state', function (s) {
            serverState = s;
            localOverride = false;               // the server's word wins over the local fallback
            if (s.idleTimeoutSeconds) { TV.idle.setTimeoutSeconds(s.idleTimeoutSeconds); }
            if (s.mode === 'RESULTS') { TV.idle.activity(); }
            applyView();
        });

        TV.bus.on('idle:timeout', function () {
            if (!approved) { return; }
            localOverride = true;
            applyView();
        });

        TV.bus.on('pairing:config', function (cfg) {
            applySettings(cfg.settings);
            if (isReady(cfg)) {
                setApproved(true);
            } else {
                showPairingInfo(cfg.pairingCode, cfg.approved);
                setApproved(false);
            }
        });

        TV.bus.on('display:approved', function () {
            TV.pairing.pollNow().then(null, function () {});
        });

        TV.bus.on('ads:forbidden', function () {
            TV.pairing.pollNow().then(null, function () {});
        });

        TV.bus.on('ads:updated', function () { TV.ads.refresh(); });

        TV.bus.on('settings:updated', function (p) {
            applySettings(p);
            TV.ads.refresh();                    // default image duration is resolved server-side
        });

        TV.bus.on('display:disconnected', function () {
            TV.log('disconnected by the administrator -> back to pairing');
            wasDisconnected = true;
            setApproved(false);                  // show the pairing screen at once
            TV.pairing.stopPolling();
            TV.socket.disconnect();
            TV.pairing.reset();                  // the old token is dead; ask for a fresh pairing code
            serverState = null;
            localOverride = false;
            TV.ui.setPairing({ code: '------', status: 'Disconnected by your administrator', statusOk: false, footer: pairingFooter() });
            recover();
        });

        TV.bus.on('api:unauthorized', recover);
        TV.bus.on('socket:authFailed', recover);

        TV.bus.on('socket:connected', function () {
            if (downTimer) { clearTimeout(downTimer); downTimer = null; }
            TV.ui.setConnection('');
            // Settings are otherwise only re-read by the slow config poll, so after a restart or a
            // dropped connection (a missed settings:updated) pick the current ones up right away.
            if (TV.pairing.hasCredentials()) { TV.pairing.pollNow().then(null, function () {}); }
        });

        TV.bus.on('socket:down', function () {
            if (downTimer) { return; }
            downTimer = setTimeout(function () {
                downTimer = null;
                if (!TV.socket.isConnected()) { TV.ui.setConnection('Connection lost - reconnecting...'); }
            }, 8000);
        });

        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                TV.ads.pause();
            } else {
                TV.ads.resume();
                if (TV.pairing.hasCredentials()) { TV.pairing.pollNow().then(null, function () {}); }
            }
        });

        window.addEventListener('online', function () {
            if (TV.pairing.hasCredentials()) {
                TV.pairing.pollNow().then(null, function () {});
                TV.ads.refresh();
            }
        });
    }

    // ------------------------------------------------------------ boot
    function init() {
        if (booted) { return; }
        booted = true;
        TV.log('init; webapis =', !!window.webapis, 'tizen =', !!window.tizen, 'backend =', TV.config.baseUrl);
        TV.ui.init();
        TV.ads.init();
        TV.results.init();
        TV.idle.init();
        TV.keys.init();
        wire();

        TV.ui.showScreen('pairing');
        TV.ui.setPairing({ code: TV.pairing.pairingCode(), status: 'Starting...', statusOk: false, footer: pairingFooter() });
        registerWithRetry(0);
    }

    TV.main = {
        init: init,
        status: function () {
            return {
                approved: approved,
                screen: TV.ui.screen(),
                mode: serverState ? serverState.mode : null,
                rev: serverState ? serverState.rev : null,
                localOverride: localOverride
            };
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
