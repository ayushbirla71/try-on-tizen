/*
 * Identity + registration. The backend identifies this TV by its DUID; we persist the
 * displayId/displayToken the backend hands back. Registering again with the same DUID
 * returns the same display with a ROTATED token, so we re-register on every boot and
 * store the new token.
 */
(function () {
    var TV = window.TV = window.TV || {};

    var state = {
        displayId: TV.store.get('displayId'),
        token: TV.store.get('displayToken'),
        pairingCode: TV.store.get('pairingCode') || '',
        approved: TV.store.get('approved') === '1'
    };
    var pollTimer = null;
    var polling = false;

    function getDuid() {
        // Real TV: stable hardware-bound id.
        try {
            if (window.webapis && webapis.productinfo && typeof webapis.productinfo.getDuid === 'function') {
                var d = webapis.productinfo.getDuid();
                if (d) { return String(d); }
            }
        } catch (e) { TV.log('getDuid failed', e && e.message); }
        // Desktop / emulator without productinfo: persisted random id.
        var fb = TV.store.get('fallbackDuid');
        if (!fb) {
            fb = 'desktop-' + TV.randomId();
            TV.store.set('fallbackDuid', fb);
        }
        return fb;
    }

    function save() {
        TV.store.set('displayId', state.displayId || '');
        TV.store.set('displayToken', state.token || '');
        TV.store.set('pairingCode', state.pairingCode || '');
        TV.store.set('approved', state.approved ? '1' : '0');
    }

    TV.pairing = {
        duid: getDuid,
        token: function () { return state.token; },
        displayId: function () { return state.displayId; },
        pairingCode: function () { return state.pairingCode; },
        wasApproved: function () { return state.approved; },
        hasCredentials: function () { return !!(state.displayId && state.token); },

        /** POST /display/register. Resolves {displayId, displayToken, pairingCode, approved, linked}. */
        register: function () {
            return TV.api.post('/display/register', { duid: getDuid() }, { auth: false }).then(function (data) {
                state.displayId = data.displayId;
                state.token = data.displayToken;
                state.pairingCode = data.pairingCode || '';
                state.approved = !!data.approved;
                save();
                return data;
            });
        },

        /** GET /display/config. Resolves the config; also records approval + pairing code. */
        fetchConfig: function () {
            return TV.api.get('/display/config').then(function (cfg) {
                if (cfg.pairingCode) { state.pairingCode = cfg.pairingCode; }
                state.approved = !!cfg.approved;
                save();
                return cfg;
            });
        },

        /** Poll config every `ms`; emits 'pairing:config' (cfg) on success. Replaces a running poll. */
        startPolling: function (ms) {
            TV.pairing.stopPolling();
            polling = true;
            function tick() {
                if (!polling) { return; }
                TV.pairing.fetchConfig().then(function (cfg) {
                    if (!polling) { return; }
                    TV.bus.emit('pairing:config', cfg);
                }, function (err) {
                    if (polling) { TV.bus.emit('pairing:configError', err); }
                }).then(function () {
                    if (polling) { pollTimer = setTimeout(tick, ms); }
                });
            }
            pollTimer = setTimeout(tick, ms);
        },

        /** Run one config check right now (used on display:approved). */
        pollNow: function () {
            return TV.pairing.fetchConfig().then(function (cfg) {
                TV.bus.emit('pairing:config', cfg);
                return cfg;
            });
        },

        stopPolling: function () {
            polling = false;
            if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        },

        /** Forget the credentials (token rejected / display deleted). */
        reset: function () {
            state.displayId = null;
            state.token = null;
            state.approved = false;
            state.pairingCode = '';
            TV.store.remove('displayId');
            TV.store.remove('displayToken');
            TV.store.remove('approved');
            TV.store.remove('pairingCode');
        }
    };
})();
