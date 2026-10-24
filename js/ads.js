/*
 * Ad loop. GET /display/playlist, then loop forever:
 *   image -> shown for durationSeconds,   video -> plays until `ended`.
 * A broken item (load error, video error, video that never starts or stalls) is skipped, so
 * the loop can never get stuck on it. If every item fails, or the playlist is empty, a branded
 * idle screen is shown and the playlist is re-fetched periodically.
 *
 * Not preloaded: videos (a second <video> can exhaust the TV's hardware decoder); images are.
 */
(function () {
    var TV = window.TV = window.TV || {};

    var imgEl, vidEl, idleEl;
    var list = [];
    var fetchedAt = 0;
    var idx = -1;
    var currentItem = null;
    var enabled = false;       // approved: playlist is fetched + refreshed
    var running = false;       // ads screen is the active one
    var paused = false;        // page hidden
    var imgTimer = null;
    var imgEndsAt = 0;
    var imgRemaining = 0;
    var watchdog = null;
    var retryTimer = null;
    var refreshTimer = null;
    var failures = 0;
    var playToken = 0;
    var videoActive = false;
    var videoStartedAt = 0;
    var videoLastPos = -1;
    var videoLastProgressAt = 0;
    var videoStarted = false;
    var shownImageId = null;
    var shownVideoId = null;
    var preloaded = {};
    var fetching = null;
    var idleShown = false;

    function cfg() { return TV.config; }
    function setShow(el, on) { TV.setClass(el, 'show', on); }

    function validAd(a) {
        return a && a.url && (a.mediaType === 'image' || a.mediaType === 'video');
    }

    // ---------------------------------------------------------------- playlist
    function saveCache(ads) {
        TV.store.setJson('playlist', { at: Date.now(), ads: ads });
    }

    function loadCache() {
        var c = TV.store.getJson('playlist');
        var ads = [];
        if (c && c.ads && c.ads.length) {
            for (var i = 0; i < c.ads.length; i++) { if (validAd(c.ads[i])) { ads.push(c.ads[i]); } }
        }
        return ads;
    }

    function applyList(ads) {
        var cur = currentItem;
        list = ads;
        fetchedAt = Date.now();
        TV.log('playlist applied:', ads.length, 'items');
        if (!running) { return; }
        if (!list.length) {
            stopMedia();
            currentItem = null;
            showIdle();
            return;
        }
        if (idleShown) {
            // Nothing was playing (empty / all failed): start now.
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            failures = 0;
            playNext();
            return;
        }
        if (cur) {
            // Keep the current item playing; make "next" continue from its new position.
            var pos = -1;
            for (var i = 0; i < list.length; i++) { if (list[i].id === cur.id) { pos = i; break; } }
            if (pos >= 0) { idx = pos; } else { idx = Math.min(idx, list.length) - 1; }
        }
    }

    function fetchPlaylist() {
        if (fetching) { return fetching; }
        fetching = TV.api.get('/display/playlist').then(function (data) {
            var ads = [];
            var src = (data && data.ads) || [];
            for (var i = 0; i < src.length; i++) { if (validAd(src[i])) { ads.push(src[i]); } }
            saveCache(ads);
            applyList(ads);
            return true;
        }, function (err) {
            TV.log('playlist fetch failed:', err.status, err.message);
            if (err.status === 403) { TV.bus.emit('ads:forbidden', err); }
            if (!list.length) {
                var cached = loadCache();
                if (cached.length) { TV.log('using cached playlist'); applyList(cached); }
            }
            return false;
        }).then(function (ok) {
            fetching = null;
            return ok;
        });
        return fetching;
    }

    // ---------------------------------------------------------------- media control
    function clearTimers() {
        if (imgTimer) { clearTimeout(imgTimer); imgTimer = null; }
        if (watchdog) { clearInterval(watchdog); watchdog = null; }
    }

    function releaseVideo() {
        videoActive = false;
        try { vidEl.pause(); } catch (e) { /* ignore */ }
        try { vidEl.removeAttribute('src'); vidEl.load(); } catch (e2) { /* ignore */ }
        setShow(vidEl, false);
        shownVideoId = null;
    }

    function stopMedia() {
        playToken++;
        clearTimers();
        releaseVideo();
    }

    function hideIdle() {
        idleShown = false;
        setShow(idleEl, false);
    }

    function showIdle() {
        idleShown = true;
        setShow(imgEl, false);
        setShow(vidEl, false);
        shownImageId = null;
        setShow(idleEl, true);
        // Keep trying to get something to play.
        if (!retryTimer && running) {
            retryTimer = setTimeout(function () {
                retryTimer = null;
                if (!running) { return; }
                fetchPlaylist().then(function () {
                    // applyList() starts playback if the fetch produced items; otherwise try again later.
                    if (running && idleShown && !retryTimer) { showIdle(); }
                });
            }, cfg().retryFetchMs);
        }
    }

    function preloadNext() {
        if (list.length < 2) { return; }
        var next = list[(idx + 1) % list.length];
        if (next && next.mediaType === 'image' && !preloaded[next.url]) {
            preloaded = {};
            var im = new Image();
            im.src = next.url;
            preloaded[next.url] = im;
        }
    }

    function fail(token, reason) {
        if (token !== playToken || !running) { return; }
        TV.log('ad item failed (' + reason + '):', currentItem && currentItem.id);
        failures++;
        stopMedia();
        if (!list.length || failures >= list.length) {
            currentItem = null;
            showIdle();
        } else {
            var t = playToken;
            setTimeout(function () { if (t === playToken && running) { playNext(); } }, 200);
        }
    }

    function advance(token) {
        if (token !== playToken || !running) { return; }
        playNext();
    }

    function startImageTimer(token, ms) {
        if (imgTimer) { clearTimeout(imgTimer); }
        imgEndsAt = Date.now() + ms;
        imgTimer = setTimeout(function () { imgTimer = null; advance(token); }, ms);
    }

    function playImage(item, token) {
        var secs = Number(item.durationSeconds) || cfg().defaultImageSeconds;
        secs = Math.max(1, Math.min(600, secs));
        var ms = secs * 1000;
        releaseVideo();
        hideIdle();

        if (list.length === 1 && shownImageId === item.id) {
            // Same single image: keep it on screen for another cycle without reloading.
            startImageTimer(token, ms);
            return;
        }

        var loader = preloaded[item.url] || new Image();
        var settled = false;
        var timeout = setTimeout(function () {
            if (settled) { return; }
            settled = true;
            fail(token, 'image load timeout');
        }, cfg().imageLoadTimeoutMs);
        function ok() {
            if (settled) { return; }
            settled = true;
            clearTimeout(timeout);
            if (token !== playToken || !running) { return; }
            failures = 0;
            imgEl.src = item.url;
            shownImageId = item.id;
            setShow(imgEl, true);
            if (!paused) { startImageTimer(token, ms); } else { imgRemaining = ms; }
            preloadNext();
        }
        loader.onload = ok;
        loader.onerror = function () {
            if (settled) { return; }
            settled = true;
            clearTimeout(timeout);
            fail(token, 'image load error');
        };
        if (loader.src && loader.complete) {
            // A preloaded image has already finished (loaded OR failed) before our handlers existed.
            if (loader.naturalWidth > 0) { ok(); } else { loader.onerror(); }
            return;
        }
        if (!loader.src) { loader.src = item.url; }
    }

    function playVideo(item, token) {
        hideIdle();
        shownImageId = null;
        videoActive = true;
        videoStarted = false;
        videoStartedAt = Date.now();
        videoLastPos = -1;
        videoLastProgressAt = Date.now();
        vidEl.muted = true;
        vidEl.loop = false;
        if (list.length === 1 && shownVideoId === item.id) {
            try { vidEl.currentTime = 0; } catch (e) { /* ignore */ }
        } else {
            vidEl.src = item.url;
            shownVideoId = item.id;
        }
        var p;
        try { p = vidEl.play(); } catch (e2) { p = null; }
        if (p && p.catch) { p.catch(function (err) { TV.log('video play() rejected', err && err.name); }); }
        if (watchdog) { clearInterval(watchdog); }
        watchdog = setInterval(function () {
            if (token !== playToken || !running || paused || !videoActive) { return; }
            var now = Date.now();
            var pos = vidEl.currentTime || 0;
            if (pos !== videoLastPos) { videoLastPos = pos; videoLastProgressAt = now; }
            if (!videoStarted && now - videoStartedAt > cfg().videoStartTimeoutMs) {
                fail(token, 'video did not start');
            } else if (videoStarted && now - videoLastProgressAt > cfg().videoStallTimeoutMs) {
                fail(token, 'video stalled');
            }
        }, 1000);
        preloadNext();
    }

    function playNext() {
        playToken++;
        var token = playToken;
        clearTimers();
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (!list.length) { currentItem = null; stopMedia(); showIdle(); return; }
        idx = (idx + 1) % list.length;
        var item = list[idx];
        currentItem = item;
        TV.log('ad ->', item.mediaType, item.id, item.title || '');
        if (item.mediaType === 'video') { playVideo(item, token); } else { playImage(item, token); }
    }

    function onVideoEvent(type) {
        if (!videoActive || !running) { return; }
        var token = playToken;
        if (type === 'playing') {
            videoStarted = true;
            videoLastProgressAt = Date.now();
            failures = 0;
            setShow(imgEl, false);
            setShow(vidEl, true);
        } else if (type === 'ended') {
            advance(token);
        } else if (type === 'error') {
            fail(token, 'video error');
        }
    }

    // ---------------------------------------------------------------- public API
    TV.ads = {
        init: function () {
            imgEl = TV.$('adImage');
            vidEl = TV.$('adVideo');
            idleEl = TV.$('adIdle');
            var fit = cfg().adFit === 'cover' ? 'cover' : 'contain';
            imgEl.style.objectFit = fit;
            vidEl.style.objectFit = fit;
            vidEl.muted = true;
            vidEl.controls = false;
            vidEl.addEventListener('playing', function () { onVideoEvent('playing'); });
            vidEl.addEventListener('ended', function () { onVideoEvent('ended'); });
            vidEl.addEventListener('error', function () { onVideoEvent('error'); });
            list = loadCache();
        },

        /** Approved: keep the playlist fresh (also while results are showing). */
        enable: function () {
            if (enabled) { return; }
            enabled = true;
            fetchPlaylist();
            refreshTimer = setInterval(fetchPlaylist, cfg().playlistRefreshMs);
        },

        disable: function () {
            enabled = false;
            if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
            TV.ads.stop();
        },

        /** Re-fetch (ads:updated, settings changed). Safe to call any time. */
        refresh: function () {
            if (enabled) { return fetchPlaylist(); }
            return Promise.resolve(false);
        },

        /** The ads screen became the active one. */
        start: function () {
            if (running) { return; }
            running = true;
            paused = false;
            failures = 0;
            if (list.length) {
                playNext();
                if (enabled && Date.now() - fetchedAt > cfg().playlistMaxAgeMs) { fetchPlaylist(); }
            } else {
                showIdle();
                if (enabled) { fetchPlaylist(); }
            }
        },

        /** The ads screen is no longer active (results shown, or unapproved). */
        stop: function () {
            running = false;
            stopMedia();
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            currentItem = null;
            shownImageId = null;
            idleShown = false;
            setShow(imgEl, false);
            setShow(idleEl, false);
        },

        /** Page hidden: stop consuming resources, keep position. */
        pause: function () {
            if (!running || paused) { return; }
            paused = true;
            if (imgTimer) {
                clearTimeout(imgTimer);
                imgTimer = null;
                imgRemaining = Math.max(1000, imgEndsAt - Date.now());
            }
            try { vidEl.pause(); } catch (e) { /* ignore */ }
        },

        resume: function () {
            if (!running || !paused) { return; }
            paused = false;
            if (currentItem && currentItem.mediaType === 'video' && videoActive) {
                videoLastProgressAt = Date.now();
                videoStartedAt = Date.now();
                try {
                    var p = vidEl.play();
                    if (p && p.catch) { p.catch(function () {}); }
                } catch (e) { /* ignore */ }
            } else if (currentItem && currentItem.mediaType === 'image' && shownImageId) {
                startImageTimer(playToken, imgRemaining || 3000);
            } else if (idleShown && enabled) {
                fetchPlaylist();
            }
        },

        /** For diagnostics / tests. */
        status: function () {
            return {
                enabled: enabled, running: running, paused: paused, idle: idleShown,
                items: list.length, index: idx,
                currentId: currentItem ? currentItem.id : null,
                currentType: currentItem ? currentItem.mediaType : null
            };
        }
    };
})();
