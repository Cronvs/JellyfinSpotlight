// Initialize global variables
let isFirstLoad = true;
let recentRetryCount = 0;
let customTitle = '';
let moviesSeriesBoth = 3, shuffleInterval = 10000, plotMaxLength = 600, useTrailers = true;
let isChangingSlide = false, player = null, slideChangeTimeout = null, isHomePageActive = false, navigationInterval = null;
let currentLocation = window.top.location.href;
let localTrailerIframe = null;
let globalVolume = Number(localStorage.getItem('spotlightVolume') ?? 0.5);

let historyList = [];
let historyIndex = -1;
let isHovering = false;
let trailerHoverTimeout = null;
let currentTrailerStarter = null;
let listenersAttached = false;

// Efficient Queueing System Variables
let idQueue = [];
let customListIds = [];
let usingCustomList = false;
let movieQueue = [];
let seenItemIds = new Set();
let isExhausted = false;
let isPreloading = false;
let isFetchingIds = false;
let failedFetchCount = 0;
let latestItemsCache = null;

// Get User Auth token
const getJellyfinAuth = () => {
    let token = null; let userId = null; let serverUrl = '';
    if (window.parent && window.parent.ApiClient) serverUrl = window.parent.ApiClient.serverAddress();
    const initEl = window.parent.document.getElementById('jellyfin-initialization-data');
    if (initEl) {
        try {
            const initJson = JSON.parse(initEl.textContent);
            token = initJson?.AccessToken;
            userId = initJson?.User?.Id;
        } catch { }
    }
    if (!token || !serverUrl) {
        try {
            const raw = window.parent.localStorage.getItem('jellyfin_credentials');
            if (raw) {
                const creds = JSON.parse(raw);
                token = token || creds?.Servers?.[0]?.AccessToken;
                userId = userId || creds?.Servers?.[0]?.UserId;
                serverUrl = serverUrl || creds?.Servers?.[0]?.ManualAddress || creds?.Servers?.[0]?.Url;
            }
        } catch { }
    }
    if (!token) {
        const v = window.parent.document.querySelector('video');
        const s = v?.currentSrc || v?.src || '';
        token = s.match(/[?&]api_key=([^&]+)/i)?.[1] || null;
    }

    // Fallback and formatting
    if (!serverUrl) serverUrl = window.parent.location.origin;
    if (serverUrl.endsWith('/')) serverUrl = serverUrl.slice(0, -1);

    return { token, userId, serverUrl };
};

const { token, userId: fallbackUserId, serverUrl: baseUrl } = getJellyfinAuth();

const saveState = () => {
    try {
        sessionStorage.setItem('spotlightState', JSON.stringify({
            idQueue,
            customListIds,
            usingCustomList,
            seenItemIds: Array.from(seenItemIds),
            isExhausted,
            historyList,
            historyIndex
        }));
    } catch (e) {
        console.warn("Could not save Spotlight state to sessionStorage.", e);
    }
};

// --- Universal Play/Pause Trailer Toggle ---
window.toggleTrailer = () => {
    const parentDoc = window.parent.document;
    const localVideo = parentDoc.getElementById('tizen-hardware-video');
    const matteOverlay = parentDoc.getElementById('tizen-matte-overlay');
    const slide = window.currentSlideElement;
    const visualWrapper = slide ? slide.querySelector('.visual-wrapper') : null;
    const txt = slide ? slide.querySelector('.text-container') : null;

    if (localVideo) {
        if (localVideo.paused) {
            localVideo.play();
            localVideo.style.opacity = '1';
            if (matteOverlay) matteOverlay.style.opacity = '1';
            if (visualWrapper) visualWrapper.style.opacity = '0';
            if (txt) txt.classList.add('fade-out');
        } else {
            localVideo.pause();
            localVideo.style.opacity = '0';
            if (matteOverlay) matteOverlay.style.opacity = '0';
            if (visualWrapper) visualWrapper.style.opacity = '1';
            if (txt) txt.classList.remove('fade-out');
        }
    } else if (player && typeof player.getPlayerState === 'function') {
        if (player.getPlayerState() === 1) {
            player.pauseVideo();
            if (visualWrapper) visualWrapper.style.opacity = '1';
            if (txt) txt.classList.remove('fade-out');
        } else {
            player.playVideo();
            if (visualWrapper) visualWrapper.style.opacity = '0';
            if (txt) txt.classList.add('fade-out');
        }
    }
};

// --- Tizen Hardware Key Reg/Unreg ---
function toggleTizenMediaKeys(enable) {
    try {
        const tizenApi = window.tizen || (window.parent && window.parent.tizen);
        if (tizenApi && tizenApi.tvinputdevice) {
            if (enable) {
                tizenApi.tvinputdevice.registerKey('VolumeMute');
                tizenApi.tvinputdevice.registerKey('MediaPlay');
                tizenApi.tvinputdevice.registerKey('MediaPause');
                tizenApi.tvinputdevice.registerKey('MediaPlayPause');
            } else {
                tizenApi.tvinputdevice.unregisterKey('VolumeMute');
                tizenApi.tvinputdevice.unregisterKey('MediaPlay');
                tizenApi.tvinputdevice.unregisterKey('MediaPause');
                tizenApi.tvinputdevice.unregisterKey('MediaPlayPause');
            }
        }
    } catch (e) {}
};

const loadState = () => {
    try {
        const saved = sessionStorage.getItem('spotlightState');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.historyList && parsed.historyList.length > 0) {
                idQueue = parsed.idQueue || [];
                customListIds = parsed.customListIds || [];
                usingCustomList = parsed.usingCustomList || false;
                seenItemIds = new Set(parsed.seenItemIds || []);
                isExhausted = parsed.isExhausted || false;

                historyList = parsed.historyList || [];
                historyIndex = parsed.historyIndex !== undefined ? parsed.historyIndex : -1;

                isFirstLoad = false;
                console.log(`Spotlight state restored. ${idQueue.length} IDs in queue.`);
                return true;
            }
        }
    } catch (e) {
        console.warn("Could not load Spotlight state from sessionStorage.", e);
    }
    return false;
};

async function playMovie(itemId) {
    const client = window.parent.ApiClient;

    // 1. The "Wake-Up" Ping
    // Make a lightweight, silent API call to force the server to update our LastActivityDate.
    // This ensures our session isn't marked as "dead" before we query the active session list.
    try {
        await client.getCurrentUser();
    } catch (e) { }

    const deviceId = client.deviceId();
    const userId = client.getCurrentUserId();
    const appName = typeof client.appName === 'function' ? client.appName() : 'Jellyfin Web';

    const sessions = await client.getSessions();

    // 2. Fuzzy Session Matching
    // Tizen and WebKit engines sometimes scramble/lose their deviceId on wake from sleep.
    // First, try the exact Device ID match:
    let mySessions = sessions.filter(s => s.DeviceId === deviceId);

    // If exact match fails, fallback to the most recent session for THIS user on THIS app type:
    if (mySessions.length === 0) {
        console.log("Spotlight: Exact DeviceId not found. Falling back to fuzzy session matching...");
        mySessions = sessions.filter(s =>
            s.UserId === userId &&
            s.Client && (s.Client === appName || s.Client.toLowerCase().includes('tizen') || s.Client.toLowerCase().includes('web'))
        );
    }

    mySessions.sort((a, b) => new Date(b.LastActivityDate) - new Date(a.LastActivityDate));
    const mySession = mySessions[0];

    if (mySession) {
        console.log("Spotlight: Dispatching Play command via ApiClient to session:", mySession.Id);
        try {
            // 3. Send the command to the verified session
            await client.sendPlayCommand(mySession.Id, {
                PlayCommand: 'PlayNow',
                ItemIds: [itemId],
                StartPositionTicks: 0,
                ControllingUserId: userId
            });
        } catch (err) {
            console.error("Spotlight: sendPlayCommand failed", err);
        }
    } else {
        console.warn("Spotlight: API Client could not find a valid session. WebSocket may be disconnected.");
        // Ultimate Safety Net: If the background socket is completely dead and the session is lost,
        // we bypass the API and use the SPA router so the button click still does something useful.
        window.parent.location.hash = '#/details?id=' + itemId;
    }
}

// Create and return a new DOM element with specified attributes
const createElem = (tag, className, textContent, src, alt) => {
    const elem = document.createElement(tag);
    if (className) elem.className = className;
    if (textContent) elem.textContent = textContent;
    if (src) elem.src = src;
    if (alt) elem.alt = alt;
    return elem;
};

// Truncate text to a specified maximum length and append '...' if truncated
const truncateText = (text, maxLength) => text && text.length > maxLength ? text.substr(0, maxLength) + '...' : text;

// Display error messages to users
const displayError = (message) => {
    const errorDiv = createElem('div', 'error-message');
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    setTimeout(() => {
        if (errorDiv.parentNode) errorDiv.parentNode.removeChild(errorDiv);
    }, 5000); // Remove after 5 seconds
};

// Clean up existing player and timeout
const cleanup = () => {
    if (player && typeof player.stopVideo === 'function') {
        player.stopVideo();
        player.destroy();
        player = null;
        console.log("YouTube player cleaned up.");
    }
    if (localTrailerIframe) {
        localTrailerIframe.remove();
        localTrailerIframe = null;
        console.log("Local trailer iframe removed.");
    }
    document.querySelectorAll(".video-container").forEach(e => e.remove());
    if (slideChangeTimeout) {
        clearTimeout(slideChangeTimeout);
        slideChangeTimeout = null;
        console.log("Slide change timeout cleared.");
    }
    if (trailerHoverTimeout) {
        clearTimeout(trailerHoverTimeout);
        trailerHoverTimeout = null;
        console.log("Slide change timeout cleared.");
    }

    document.querySelectorAll('.visual-wrapper').forEach(vw => vw.style.opacity = '1');
    document.querySelectorAll('.text-container').forEach(txt => txt.classList.remove('fade-out'));
};

// Shut down the slideshow by cleaning up and resetting variables
const shutdown = () => {
    isChangingSlide = true;
    cleanup();
    document.getElementById('rightButton').onclick = null;
    document.getElementById('leftButton').onclick = null;

    isHomePageActive = false;
    isChangingSlide = false;

    saveState();

    isPreloading = false;
    isFetchingIds = false;

    console.log("Slideshow has been safely paused");
};

const updateVolumeButtonVisibility = (show) => {
    const btn = document.getElementById('volumeButton');
    if (btn) {
        if (show) btn.classList.add('visible');
        else btn.classList.remove('visible');
    }
};

// Update the state of navigation buttons based on the current and last movie
const updateSlideButtons = () => {
    const leftBtn = document.getElementById('leftButton');
    const rightBtn = document.getElementById('rightButton');

    if (leftBtn) {
        const canGoBack = historyIndex > 0;
        leftBtn.disabled = !canGoBack;
        if (!canGoBack) leftBtn.setAttribute('disabled', 'true'); else leftBtn.removeAttribute('disabled');

        leftBtn.style.opacity = canGoBack ? '1' : '0.3';
        leftBtn.style.cursor = canGoBack ? 'pointer' : 'default';
        leftBtn.style.pointerEvents = canGoBack ? 'auto' : 'none';
    }
    if (rightBtn) {
        const isAtEnd = isExhausted && historyIndex >= historyList.length - 1;
        const canGoForward = !isAtEnd;
        rightBtn.disabled = !canGoForward;
        if (!canGoForward) rightBtn.setAttribute('disabled', 'true'); else rightBtn.removeAttribute('disabled');

        rightBtn.style.opacity = canGoForward ? '1' : '0.3';
        rightBtn.style.cursor = canGoForward ? 'pointer' : 'default';
        rightBtn.style.pointerEvents = canGoForward ? 'auto' : 'none';
    }
};

async function checkLocalTrailer(itemId) {
    const uid = fallbackUserId;
    if (!token || !uid) return null;

    try {
        const res = await fetch(`${baseUrl}/Users/${uid}/Items/${itemId}/LocalTrailers?api_key=${token}`);
        if (!res.ok) return null;
        const arr = await res.json();
        if (!arr?.length) return null;
        const t = arr[0];
        const mediaSourceId = t.MediaSources?.[0]?.Id;
        const streamUrl = mediaSourceId ? `${baseUrl}/Videos/${t.Id}/stream.mp4?Static=true&mediaSourceId=${mediaSourceId}&api_key=${token}` : null;
        return { trailer: t, streamUrl };
    } catch (e) {
        console.warn("Local trailer check failed:", e);
        return null;
    }
}

const createSlideElement = async (movie) => {
    if (isFirstLoad) {
        console.log("✅ Valid 'Recent' movie displayed. Switching to Random pool.");
        isFirstLoad = false;
        recentRetryCount = 0;
    }
    cleanup(); // Clean previous iframe

    // Note: We do NOT reset isHovering here.
    // If the mouse is already there (e.g. clicked Next), we stay hovering.

    updateVolumeButtonVisibility(false);
    if (trailerHoverTimeout) clearTimeout(trailerHoverTimeout);

    const parentDoc = window.parent.document;
    const container = document.getElementById('slides-container');
    const newSlide = createElem('div', 'slide');

    // 1. Visuals
    // Robust RGB parser for clean opacity transitions
    let r = 16, g = 16, b = 16;
    try {
        const themeElement = parentDoc.querySelector('.backgroundContainer') || parentDoc.body;
        const computed = window.getComputedStyle(themeElement).backgroundColor;
        const match = computed.match(/\d+/g);
        if (match && match.length >= 3) {
            r = match[0]; g = match[1]; b = match[2];
        }
    } catch(e) {}
    const rgb = `${r}, ${g}, ${b}`;

    const visualWrapper = createElem('div', 'visual-wrapper');
    visualWrapper.style.transition = 'opacity 1.5s ease-in-out';

    const shadowStyle = document.createElement('style');
    shadowStyle.innerHTML = `.visual-wrapper::after { left: 0 !important; width: 100% !important; background: linear-gradient(to right, rgba(${rgb}, 1) 0%, rgba(${rgb}, 1) 10%, rgba(${rgb}, 0.6) 40%, rgba(${rgb}, 0) 100%) !important; }`;
    visualWrapper.appendChild(shadowStyle);

    const backdropImg = createElem('img', 'backdrop', null, `${baseUrl}/Items/${movie.Id}/Images/Backdrop/0`, 'backdrop');
    visualWrapper.appendChild(backdropImg);
    newSlide.appendChild(visualWrapper);

    // 2. Rating & Metadata
    const getCleanRating = (r) => {
        if (!r) return null;
        r = r.toUpperCase();
        if (['TV-MA', 'NC-17', 'R', '18', 'VM18'].some(x => r.includes(x))) return '18+';
        if (['16', 'VM16'].some(x => r.includes(x))) return '16+';
        if (['PG-13', 'TV-14', '14', 'VM14'].some(x => r.includes(x))) return '14+';
        if (['PG', 'TV-PG', '12', '10'].some(x => r.includes(x))) return '12+';
        return null;
    };
    const cleanRating = getCleanRating(movie.OfficialRating);
    if (cleanRating) {
        const ratingBox = createElem('div', 'age-rating-box');
        ratingBox.textContent = cleanRating;
        newSlide.appendChild(ratingBox);
    }

    const textContainer = createElem('div', 'text-container');
    const logoImg = new Image();

    logoImg.onload = () => textContainer.prepend(createElem('img', 'logo', null, logoImg.src, 'logo'));
    logoImg.onerror = () => {
        const titleEl = document.createElement('h1');
        titleEl.className = 'title-text';
        titleEl.textContent = movie.Name;
        textContainer.prepend(titleEl);
    };
    logoImg.src = `${baseUrl}/Items/${movie.Id}/Images/Logo`;

    const year = movie.PremiereDate ? new Date(movie.PremiereDate).getFullYear() : '';
    const genres = movie.Genres ? movie.Genres.slice(0, 2).join(', ') : '';
    const duration = movie.RunTimeTicks ? Math.round(movie.RunTimeTicks / 600000000) + 'm' : '';
    const commRating = movie.CommunityRating ? movie.CommunityRating.toFixed(1) : '';

    let metaHTML = ``;
    if (commRating) metaHTML += `<span class="star-rating"><span class="material-icons">star</span> ${commRating}</span>`;
    if (year) metaHTML += `<span>${year}</span>`;
    if (duration) metaHTML += `<span>${duration}</span>`;
    if (genres) metaHTML += `<span>${genres}</span>`;

    const loremDiv = createElem('div', 'lorem-ipsum');
    loremDiv.innerHTML = metaHTML;
    textContainer.appendChild(loremDiv);
    textContainer.appendChild(createElem('div', 'plot', truncateText(movie.Overview, plotMaxLength)));

    const btnContainer = createElem('div', 'hero-buttons');
    const playBtn = createElem('button', 'btn-hero btn-play');
    playBtn.innerHTML = '<span class="material-icons">play_arrow</span> Play';
    playBtn.onclick = (e) => {
        e.stopPropagation();
        playMovie(movie.Id);
    };

    const infoBtn = createElem('button', 'btn-hero btn-info');
    infoBtn.innerHTML = '<span class="material-icons">info_outline</span> More Info';
    infoBtn.onclick = (e) => {
        e.stopPropagation();
        window.parent.location.hash = '#/details?id=' + movie.Id;
    };
    
    btnContainer.appendChild(playBtn);
    btnContainer.appendChild(infoBtn);
    textContainer.appendChild(btnContainer);
    newSlide.appendChild(textContainer);

    // 3. Define Trailer Logic
    const startTrailer = async () => {
        if (!useTrailers) return;
        const localData = movie.localTrailerData;
        if (!isHovering) return; 
        if (newSlide.querySelector('.video-container')) return;

        const videoContainer = createElem('div', 'video-container');
        const clickOverlay = createElem('div', 'video-click-overlay');
        Object.assign(clickOverlay.style, { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 999, cursor: 'pointer', background: 'transparent' });
        videoContainer.appendChild(clickOverlay);

        let videoAdded = false;

        if (localData) {
            const { streamUrl } = localData;
            const wrapper = parentDoc.getElementById('spotlight-wrapper-tizen');

            if (wrapper) {
                const video = parentDoc.createElement('video');
                video.id = 'tizen-hardware-video'; video.autoplay = true;
                video.src = streamUrl;
                video.style.transition = 'opacity 1s ease';
                video.setAttribute('playsinline', 'true'); video.setAttribute('webkit-playsinline', 'true');

                // Standard 100% fit (No zoom/overfill)
                video.style.cssText = `
                    position: absolute !important;
                    top: 0 !important; left: 0 !important; right: auto !important;
                    width: 100% !important;
                    height: calc(100% - 55px) !important;
                    object-fit: cover !important; object-position: center !important;
                    z-index: 0 !important; background: transparent !important; pointer-events: none !important;
                `;

                // LOWER OPACITY CURVE: Hard 1.0 at 0%, fast dropoff to soft transparency.
                const matteOverlay = parentDoc.createElement('div');
                matteOverlay.id = 'tizen-matte-overlay';
                matteOverlay.style.transition = 'opacity 1s ease';
                matteOverlay.style.cssText = `
                    position: absolute; left: -20px; right: -20px;
                    bottom: 55px; height: 80px;
                    z-index: 1; pointer-events: none;
                    background: linear-gradient(to top,
                        rgba(${rgb}, 1) 0%,
                        rgba(${rgb}, 0.8) 15%,
                        rgba(${rgb}, 0.4) 45%,
                        rgba(${rgb}, 0.15) 75%,
                        rgba(${rgb}, 0) 100%);
                `;

                parentDoc.body.classList.add('transparentDocument');
                const bgElements = parentDoc.querySelectorAll('.backgroundContainer, .backdropContainer');
                bgElements.forEach(el => el.style.opacity = '0');

                video.onended = () => { fetchRandomMovie(); };

                const iframeRef = parentDoc.getElementById('spotlight-iframe');
                if (iframeRef) {
                    wrapper.insertBefore(video, iframeRef);
                    wrapper.insertBefore(matteOverlay, iframeRef);
                } else {
                    wrapper.appendChild(video); wrapper.appendChild(matteOverlay);
                }

                localTrailerIframe = {
                    remove: () => {
                        video.remove();
                        if (matteOverlay) matteOverlay.remove();
                        if (visualWrapper) visualWrapper.style.opacity = '1';
                        const txt = newSlide.querySelector('.text-container');
                        if (txt) txt.classList.remove('fade-out');
                        parentDoc.body.classList.remove('transparentDocument');
                        bgElements.forEach(el => el.style.opacity = '');
                    }
                };

                clickOverlay.onclick = (e) => { e.stopPropagation(); window.toggleTrailer(); };
                videoAdded = true;
            }
        }// else if (movie.RemoteTrailers?.length > 0 && window.YT) {
        //    const trailerUrl = movie.RemoteTrailers[0].Url;
        //    const videoId = trailerUrl.match(/[?&]v=([^&]+)/)?.[1];
        //    if (videoId) {
        //        const vidDiv = createElem('div', 'video-player');
        //        videoContainer.appendChild(vidDiv);

        //        player = new YT.Player(vidDiv, {
        //            height: '100%', width: '100%', videoId: videoId,
        //            playerVars: { 'autoplay': 1, 'controls': 0, 'modestbranding': 1, 'rel': 0, 'iv_load_policy': 3, 'disablekb': 1, 'fs': 0, 'playsinline': 1 },
        //            events: {
        //                'onReady': (e) => {
        //                    if(!isHovering) { cleanup(); return; }
        //                    visualWrapper.style.opacity = '0';
        //                    updateVolumeButtonVisibility(true);
        //                    const txt = newSlide.querySelector('.text-container');
        //                    if(txt) txt.classList.add('fade-out');
        //                },
        //                'onStateChange': (e) => {
        //                    if (e.data === YT.PlayerState.ENDED) {
        //                        visualWrapper.style.opacity = '1';
        //                        const txt = newSlide.querySelector('.text-container');
        //                        if (txt) txt.classList.remove('fade-out');
        //                        cleanup();
        //                    }
        //                }
        //            }
        //        });
        //        clickOverlay.onclick = (e) => { e.stopPropagation(); window.toggleTrailer(); };
        //        videoAdded = true;
        //    }
        //}

        if (videoAdded) {
            newSlide.appendChild(videoContainer);
            if (localData) {
                 setTimeout(() => { 
                     if(isHovering) {
                         visualWrapper.style.opacity = '0';
                         updateVolumeButtonVisibility(true);
                         const txt = newSlide.querySelector('.text-container');
                         if(txt) txt.classList.add('fade-out');
                     }
                 }, 500);
            }
        }
    };

    // Update the global reference to the current trailer starter
    currentTrailerStarter = startTrailer;

    // Check immediately if we are already hovering (e.g. user clicked Next)
    if (isHovering) {
        trailerHoverTimeout = setTimeout(() => {
            if (isHovering && currentTrailerStarter) currentTrailerStarter();
        }, 300);
    }

    // Mount Slide
    if (window.currentSlideElement) {
        const old = window.currentSlideElement;
        old.classList.remove('visible');
        setTimeout(() => old.remove(), 1300);
    }

    container.appendChild(newSlide);
    void newSlide.offsetWidth;
    newSlide.classList.add('visible');

    window.currentSlideElement = newSlide;
    window.currentMovie = movie;
    updateSlideButtons();

    isChangingSlide = false;
};

// Read a custom list of movie IDs from 'list.txt' and update the title
const readCustomList = () =>
    fetch('list.txt?' + new Date().getTime()).then(response => response.ok ? response.text() : null)
        .then(text => {
            if (!text) return null;
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length > 0 && lines[0].length !== 32) lines.shift();
            return lines.map(line => line.substring(0, 32));
        })
        .catch(error => {
            console.error("Error reading custom list:", error);
            return null;
        });

// Top up idQueue so it is always 10-19 ahead of current progression
async function fetchMoreIds() {
    if (isFetchingIds || idQueue.length > 9 || isExhausted) return;
    isFetchingIds = true;
    try {
        if (usingCustomList) {
            let added = 0;
            while (added < 10 && customListIds.length > 0) {
                const id = customListIds.shift();
                if (!seenItemIds.has(id)) {
                    idQueue.push(id);
                    added++;
                }
            }
            if (added === 0 && customListIds.length === 0) isExhausted = true;
        } else {
            const uid = fallbackUserId;
            const itemTypes = moviesSeriesBoth === 1 ? 'Movie' : (moviesSeriesBoth === 2 ? 'Series' : 'Movie,Series');

            const res = await fetch(`${baseUrl}/Users/${uid}/Items?IncludeItemTypes=${itemTypes}&MinCommunityRating=4&Recursive=true&SortBy=Random&Limit=10&Fields=Id&api_key=${token}&_t=${Date.now()}`);
            const data = await res.json();

            let added = 0;
            for (let item of (data.Items || [])) {
                if (!seenItemIds.has(item.Id) && !idQueue.includes(item.Id)) {
                    idQueue.push(item.Id);
                    added++;
                }
            }

            // Exhaustion check
            if (added === 0 && (data.Items || []).length > 0) {
                failedFetchCount++;
                if (failedFetchCount >= 5) {
                    console.warn("No more new random movies found. Library exhausted.");
                    isExhausted = true;
                }
            } else {
                failedFetchCount = 0;
            }
        }
        saveState();
    } catch (e) {
        console.error("Error fetching IDs:", e);
    } finally {
        isFetchingIds = false;
    }
}

// Wrapper to locally preload Image assets and validate
const preloadImages = (movie) => {
    return new Promise((resolve) => {
        if ((movie.CommunityRating || 0) < 4) return resolve(false);

        let backdropLoaded = false, logoLoaded = false, failed = false;
        const checkDone = () => { if (!failed && backdropLoaded && logoLoaded) resolve(true); };

        const imgBack = new Image();
        imgBack.onload = () => { backdropLoaded = true; checkDone(); };
        imgBack.onerror = () => { failed = true; resolve(false); };
        imgBack.src = `${baseUrl}/Items/${movie.Id}/Images/Backdrop/0`;

        const imgLogo = new Image();
        imgLogo.onload = () => { logoLoaded = true; checkDone(); };
        imgLogo.onerror = () => { failed = true; resolve(false); };
        imgLogo.src = `${baseUrl}/Items/${movie.Id}/Images/Logo`;
    });
};

// Safe, single-threaded while loop replacing dangerous recursion
async function preloadNextMovies() {
    if (isPreloading) return;
    isPreloading = true;

    if (idQueue.length <= 9) await fetchMoreIds();

    while (movieQueue.length < 2 && idQueue.length > 0) {
        const nextId = idQueue.shift();

        // Strict double-check: ensures an ID didn't sneak in before "Latest" was saved
        if (seenItemIds.has(nextId)) continue;

        const uid = fallbackUserId;
        try {
            const res = await fetch(`${baseUrl}/Users/${uid}/Items?Ids=${nextId}&Fields=Id,Overview,RemoteTrailers,PremiereDate,RunTimeTicks,ChildCount,Title,Type,Genres,OfficialRating,CommunityRating&api_key=${token}`);
            const data = await res.json();
            const movie = data.Items && data.Items[0];

            if (movie) {
                seenItemIds.add(movie.Id);
                saveState();

                // Validate Assets
                const validImages = await preloadImages(movie);
                if (validImages) {
                    movie.localTrailerData = await checkLocalTrailer(movie.Id);
                    movieQueue.push(movie);
                }
            }
        } catch (e) {
            console.error("Error preloading movie:", e);
        }

        // If idQueue runs low inside the while loop, fetch more
        if (idQueue.length === 0 && !isExhausted) {
            await fetchMoreIds();
        }
    }

    isPreloading = false;
}

const initOrResume = async () => {
    if (isChangingSlide) return;
    isChangingSlide = true;

    // Restore state or establish first batch
    if (idQueue.length === 0 && !isExhausted) {
        if (!loadState()) {
            try {
                const cl = await readCustomList();
                if (cl && cl.length > 0) {
                    customListIds = cl;
                    usingCustomList = true;
                }
                await fetchMoreIds();
                saveState();
            } catch (error) {
                console.error("Error during initial queue setup:", error);
            }
        }
    }

    const container = document.getElementById('slides-container');
    if (window.currentSlideElement && container && container.contains(window.currentSlideElement)) {
        updateSlideButtons();
        isChangingSlide = false;
        preloadNextMovies();
        return;
    }

    // If we have an active history from a restored session, resume it flawlessly
    if (historyList.length > 0 && historyIndex >= 0) {
        createSlideElement(historyList[historyIndex]);
        preloadNextMovies(); // Replenish in background
    } else {
        // Starting fresh
        isChangingSlide = false;
        fetchNextMovie();
    }
};

const fetchRandomMovie = async () => {
    if (isChangingSlide) return;
    isChangingSlide = true;
    fetchNextMovie();
};

const fetchNextMovie = async () => {
    // A. Check History
    if (historyIndex < historyList.length - 1) {
        historyIndex++;
        createSlideElement(historyList[historyIndex]);
        return;
    }
    const uid = fallbackUserId;
    const itemTypes = moviesSeriesBoth === 1 ? 'Movie' : (moviesSeriesBoth === 2 ? 'Series' : 'Movie,Series');

    // B. Fast First Load (Latest API)
    if (isFirstLoad) {
        if (recentRetryCount >= 15) {
            console.log("⚠️ End of recent items buffer. Switching to random pool.");
            isFirstLoad = false;
            return fetchNextMovie();
        }
        try {
            if (!latestItemsCache) {
                const r = await fetch(`${baseUrl}/Users/${uid}/Items/Latest?IncludeItemTypes=${itemTypes}&MinCommunityRating=4&Limit=15&Fields=Id,Overview,RemoteTrailers,PremiereDate,RunTimeTicks,ChildCount,Title,Type,Genres,OfficialRating,CommunityRating&api_key=${token}`);
                latestItemsCache = await r.json();
            }

            const candidate = latestItemsCache[recentRetryCount];
            if (candidate) {
                recentRetryCount++;
                if (!seenItemIds.has(candidate.Id)) {
                    seenItemIds.add(candidate.Id);
                    saveState();
                    const valid = await preloadImages(candidate);
                    if (valid) {
                        candidate.localTrailerData = await checkLocalTrailer(candidate.Id);
                        addToHistory(candidate);
                        createSlideElement(candidate);

                        preloadNextMovies(); // Top up background buffer immediately
                        return;
                    }
                }
                return fetchNextMovie();
            } else {
                isFirstLoad = false;
            }
        } catch (error) {
            console.error("Error fetching latest:", error);
            isFirstLoad = false;
        }
    }

    // C. Wait for Queue and Exhaustion State safely
    if (movieQueue.length === 0) {
        if (idQueue.length === 0 && isExhausted) {
            console.warn("No more movies to show!");
            isExhausted = true;
            isChangingSlide = false;
            saveState();
            updateSlideButtons();
            return;
        }

        await preloadNextMovies();

        if (movieQueue.length === 0) {
            console.error("Failed to preload any movies. Aborting to prevent lockup.");
            isChangingSlide = false;
            return;
        }
    }

    // D. Extract Preloaded Buffer
    const candidate = movieQueue.shift();
    addToHistory(candidate);
    createSlideElement(candidate);

    // E. Top up background
    preloadNextMovies();
};

const navigatePrevious = () => {
    if (historyIndex > 0) {
        historyIndex--;
        console.log("History Back:", historyList[historyIndex].Name);
        createSlideElement(historyList[historyIndex]);
    }
};

const addToHistory = (movie) => {
    // Only add if we are at the end of the stack
    if (historyIndex === historyList.length - 1) {
        historyList.push(movie);
        historyIndex++;
        // Limit Stack
        if (historyList.length > 30) {
            historyList.shift();
            historyIndex--;
        }
    } else {
        // Edge case: If user went back 5 times, then clicked "Random/Next" (not Forward),
        // we usually branch off a new history.
        // For simplicity here, we just wipe the forward history and append.
        historyList = historyList.slice(0, historyIndex + 1);
        historyList.push(movie);
        historyIndex++;
    }
};

const waitForVisibilityAndResume = () => {
    attachButtonListeners();

    let attempts = 0;
    const check = () => {
        attempts++;
        const wrapper = window.parent.document.getElementById('spotlight-wrapper-tizen');

        if ((wrapper && wrapper.offsetParent !== null) || attempts > 60) {
            setTimeout(() => {
                initOrResume();
            }, 50);
        } else {
            requestAnimationFrame(check);
        }
    };
    requestAnimationFrame(check);
};

const checkNavigation = () => {
    const newLocation = window.top.location.href;
    const isHomePage = newLocation.includes("/web/#/home.html") ||
        newLocation.includes("/web/#/home") ||
        newLocation.includes("/web/index.html#/home.html") ||
        newLocation === "/web/index.html#/home" ||
        newLocation.endsWith("/web/");

    if (newLocation !== currentLocation) {
        currentLocation = newLocation;

        if (isHomePage) {
            if (!isHomePageActive) {
                console.log("Returning to homepage, reactivating slideshow");
                isHomePageActive = true;
                cleanup();
                waitForVisibilityAndResume();
            }
            return;
        }
        if (isHomePageActive) {
            console.log("Leaving homepage, shutting down slideshow");
            shutdown();
            return;
        }
        return;
    }

    // navback
    if (isHomePage && !window.parent.document.getElementById("spotlight-iframe")) {
        console.log("Returning to homepage, reactivating slideshow");
        isHomePageActive = true;
        cleanup();
        waitForVisibilityAndResume();
        return;
    }
};

// Attach event listeners to navigation buttons
const attachButtonListeners = () => {
    if (listenersAttached) return;
    listenersAttached = true;

    const rightButton = document.getElementById('rightButton');
    const leftButton = document.getElementById('leftButton');

    if (rightButton && leftButton) {
        rightButton.onclick = fetchRandomMovie; // Mapped to advance
        leftButton.onclick = navigatePrevious;
        console.log("Navigation button listeners attached.");
    }

    window.addEventListener('focus', () => {
        isHovering = true;
        toggleTizenMediaKeys(true);
        if (trailerHoverTimeout) clearTimeout(trailerHoverTimeout);
        trailerHoverTimeout = setTimeout(() => { if (isHovering && currentTrailerStarter) currentTrailerStarter(); }, 300);
    });

    window.addEventListener('blur', () => {
        isHovering = false;
        toggleTizenMediaKeys(false);
        if (trailerHoverTimeout) clearTimeout(trailerHoverTimeout);
        cleanup();
        updateVolumeButtonVisibility(false);
    });

    document.body.addEventListener('mouseenter', () => { window.focus(); });
    document.body.addEventListener('mousemove', () => { if (!isHovering) window.focus(); });
    document.body.addEventListener('mouseleave', () => { window.blur(); });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') {
            fetchRandomMovie();
        }
        else if (e.key === 'ArrowLeft') {
            navigatePrevious();
        }
        else if (e.key === 'ArrowDown') {
            // Escape iframe: Push focus down to the first media card in Jellyfin
            if (window.parent) {
                // FIXED DOM CACHE VISIBILITY FOR ARROWDOWN
                const sections = Array.from(window.parent.document.querySelectorAll('.section0'));
                const visibleSection = sections.find(el => el.offsetParent !== null);
                const nextCard = visibleSection ? visibleSection.querySelector('.card, .itemAction, .emby-button') : null;
                if (nextCard) nextCard.focus();
            }
        }
        else if (e.key === 'ArrowUp') {
            // Escape iframe: Push focus up to the Jellyfin top menu header
            if (window.parent) {
                const topMenu = window.parent.document.querySelector('.headerTabs .emby-tab-button[data-index="0"]');
                if (topMenu) topMenu.focus();
            }
        }
        else if (e.key === 'VolumeMute' || e.keyCode === 449 || e.keyCode === 173) {
            e.preventDefault(); e.stopPropagation();
            window.toggleTrailer();
            return;
        }
        else if (e.key === 'MediaPlay' || e.key === 'Play' || e.key === 'MediaPlayPause' || e.keyCode === 415 || e.keyCode === 179 || e.keyCode === 10252) {
            e.preventDefault(); e.stopPropagation();
            if (window.currentMovie && window.currentMovie.Id) playMovie(window.currentMovie.Id);
            return;
        }
        else if (e.key === 'Enter') {
            if (document.activeElement && document.activeElement.tagName === 'BUTTON') return;
            e.stopPropagation();
            if (window.currentMovie && window.currentMovie.Id) window.parent.location.hash = '#/details?id=' + window.currentMovie.Id;
        }
        else if (e.keyCode === 10009) {
            if (window.parent) {
                const clonedEvent = new KeyboardEvent('keydown', { key: e.key, keyCode: e.keyCode, code: e.code, which: e.keyCode, bubbles: true, cancelable: true });
                window.parent.document.dispatchEvent(clonedEvent);
            }
        }
    });
};

function initVolumeControl() {
    const button = document.getElementById('volumeButton');

    if (button) {
        button.addEventListener('click', e => {
            window.toggleTrailer();
        });
    }

    const slider = document.getElementById('volumeSlider');
    if (slider) slider.style.display = 'none';
}

// Initialize the slideshow once the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    if (window.innerWidth < 701) useTrailers = false;
    const isHomePage = url => url.includes('/home') || url.endsWith('/web/') || url.endsWith('/web/index.html');
    if (isHomePage(window.top.location.href)) {
        isHomePageActive = true;
        cleanup();
        initOrResume();
        attachButtonListeners();
        initVolumeControl();
        console.log("Slideshow initialized on homepage.");
    }
    navigationInterval = setInterval(checkNavigation, 250);
    console.log("Navigation check interval started.");
}, { passive: true });

// Expose controlYouTubePlayer to the global window scope
window.controlYouTubePlayer = {
    toggle: function () {
        window.toggleTrailer();
    }
};
