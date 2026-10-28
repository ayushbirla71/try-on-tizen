/*
 * TryOn TV - configuration. EDIT THIS FILE (only here) before building the .wgt.
 *
 *   baseUrl      Origin of the backend (scheme + host [+ port], NO trailing slash, NO /api/v1).
 *                Used for REST and for the Socket.IO connection (namespace /display).
 *                The TV must be able to reach it over the network: do NOT use "localhost" on a
 *                real TV (localhost = the TV itself). Use the server's LAN IP or public https URL.
 *   apiBasePath  The backend's API_BASE_PATH (default /api/v1).
 *
 * For desktop testing only (ignored on a real TV, where window.tizen exists) the backend can be
 * overridden with the query string, e.g.  index.html?backend=http://localhost:3997
 */
(function () {
    var TV = window.TV = window.TV || {};

    var cfg = {
        // ---- EDIT ME ------------------------------------------------------------------
        baseUrl: 'https://tryon.ad96.in',
        apiBasePath: '/api/v1',
        // -------------------------------------------------------------------------------

        socketPath: '/socket.io',

        // Pairing
        pairingPollMs: 10000,          // GET /display/config while waiting for approval
        configPollMs: 60000,           // slow poll after approval (settings, un-approval detection)
        requireLinkBeforeAds: false,   // true = keep the pairing screen until the admin also links a kiosk

        // Sockets
        heartbeatMs: 30000,

        // Ads
        playlistRefreshMs: 30 * 60 * 1000, // signed URLs expire (~1 h)
        playlistMaxAgeMs: 25 * 60 * 1000,  // re-fetch when coming back to ads if older than this
        defaultImageSeconds: 8,            // used only if the server gives no duration
        adFit: 'contain',                  // 'contain' (letterbox) or 'cover' (crop to fill)
        imageLoadTimeoutMs: 10000,
        videoStartTimeoutMs: 20000,        // video must start playing within this
        videoStallTimeoutMs: 15000,        // playback position must advance at least this often
        retryFetchMs: 15000,               // when nothing playable: retry the playlist this often

        // Results / idle
        defaultIdleSeconds: 120,           // until the server tells us (display:state.idleTimeoutSeconds)

        // REST
        apiTimeoutMs: 15000,

        debug: false
    };

    // Desktop-only backend override (never honoured on a real TV).
    try {
        if (!window.tizen && window.location && window.location.search) {
            var m = /[?&]backend=([^&]+)/.exec(window.location.search);
            if (m) { cfg.baseUrl = decodeURIComponent(m[1]).replace(/\/+$/, ''); }
            if (/[?&]debug=1/.test(window.location.search)) { cfg.debug = true; }
        }
    } catch (e) { /* ignore */ }

    TV.config = cfg;
})();
