// Initialize global variables
let isFirstLoad = true;
let recentRetryCount = 0;
let customTitle = '';
let moviesSeriesBoth = 3, shuffleInterval = 10000, plotMaxLength = 600, useTrailers = true;
let isChangingSlide = false, player = null, slideChangeTimeout = null, isHomePageActive = false, navigationInterval = null;
let currentLocation = window.top.location.href;
let localTrailerIframe = null;
let globalVolume = Number(localStorage.getItem('spotlightVolume') ?? 0.5);

let historyList = [];       // Stores movie objects
let historyIndex = -1;      // Points to current movie in history
let isHovering = false;
let trailerHoverTimeout = null;
let currentTrailerStarter = null;
let listenersAttached = false;

// --- Efficient Queueing System Variables ---
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
// -------------------------------------------

// Get User Auth token
const getJellyfinAuth = () => {
    let token = null;
    let userId = null;
    let serverUrl = '';

    // Extract Server URL via ApiClient
    if (window.parent && window.parent.ApiClient) {
        serverUrl = window.parent.ApiClient.serverAddress();
    }

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

// --- Session Storage Management ---
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

const loadState = () => {
    try {
        const saved = sessionStorage.getItem('spotlightState');
        if (saved) {
            const parsed = JSON.parse(saved);
            if ((parsed.idQueue && parsed.idQueue.length > 0) || parsed.isExhausted) {
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
// ----------------------------------

async function playMovie(itemId) {
    const client = window.parent.ApiClient;
    const deviceId = client.deviceId();
    const sessions = await client.getSessions();
    const mySessions = sessions.filter(s => s.DeviceId === deviceId);
    mySessions.sort((a,b) => new Date(b.LastActivityDate) - new Date(a.LastActivityDate))

    const mySession = mySessions[0];
    if (mySession) {
        await client.sendPlayCommand(mySession.Id, {
            PlayCommand: 'PlayNow',
            ItemIds: [itemId],
            StartPositionTicks: 0,
            ControllingUserId: client.getCurrentUserId() 
        });
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
    document.querySelectorAll(".video-container").forEach(e => e.remove())
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

    const txt = document.querySelector('.text-container');
    if (txt) txt.classList.remove('fade-out');
};

// Shut down the slideshow by cleaning up and resetting variables
const shutdown = () => {
    isChangingSlide = true;
    cleanup();
    document.getElementById('rightButton').onclick = null;
    document.getElementById('leftButton').onclick = null;
    const container = document.getElementById('slides-container');
    if (container) container.innerHTML = '';
    isHomePageActive = false;
    isChangingSlide = false;
    listenersAttached = false;

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
        const streamUrl = mediaSourceId
            ? `${baseUrl}/Videos/${t.Id}/stream.mp4?Static=true&mediaSourceId=${mediaSourceId}&api_key=${token}`
            : null;

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

    const container = document.getElementById('slides-container');
    const newSlide = createElem('div', 'slide');

    // 1. Visuals
    const visualWrapper = createElem('div', 'visual-wrapper');
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
    logoImg.src = `${baseUrl}/Items/${movie.Id}/Images/Logo`;
    logoImg.onload = () => textContainer.prepend(createElem('img', 'logo', null, logoImg.src, 'logo'));
    logoImg.onerror = () => {
        const titleEl = document.createElement('h1');
        titleEl.className = 'title-text';
        titleEl.textContent = movie.Name;
        textContainer.prepend(titleEl);
    };

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
        window.top.Emby.Page.showItem(movie.Id); 
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
            const iframe = document.createElement('iframe');
            iframe.className = 'local-trailer-frame';
            iframe.allow = 'autoplay';
            iframe.style.border = '0';
            iframe.srcdoc = `
                <style>body{margin:0;background:#000;overflow:hidden;}video{width:100%;height:100%;object-fit:cover;}</style>
                <video id="v" autoplay src="${streamUrl}"></video>
                <script>
                    const v=document.getElementById('v');
                    v.volume=${globalVolume};
                    v.onended = () => parent.postMessage('local-trailer-ended', '*');
                    window.addEventListener('message', e => {
                        if(e.data==='toggle') { v.paused?v.play():v.pause(); }
                        else if(e.data && e.data.type==='setVolume') { v.volume=e.data.value; }
                    });
                <\/script>`;
            videoContainer.appendChild(iframe);
            localTrailerIframe = iframe;
            clickOverlay.onclick = () => iframe.contentWindow.postMessage('toggle', '*');
            videoAdded = true;
        } else if (movie.RemoteTrailers?.length > 0 && window.YT) {
            const trailerUrl = movie.RemoteTrailers[0].Url;
            const videoId = trailerUrl.match(/[?&]v=([^&]+)/)?.[1];
            if (videoId) {
                const vidDiv = createElem('div', 'video-player');
                videoContainer.appendChild(vidDiv);

                player = new YT.Player(vidDiv, {
                    height: '100%', width: '100%', videoId: videoId,
                    playerVars: { 'autoplay': 1, 'controls': 0, 'modestbranding': 1, 'rel': 0, 'iv_load_policy': 3, 'disablekb': 1, 'fs': 0, 'playsinline': 1 },
                    events: {
                        'onReady': (e) => {
                            if(!isHovering) { cleanup(); return; }
                            e.target.setVolume(globalVolume * 100);
                            backdropImg.style.opacity = '0';
                            updateVolumeButtonVisibility(true);
                            const txt = newSlide.querySelector('.text-container');
                            if(txt) txt.classList.add('fade-out');
                        },
                        'onStateChange': (e) => {
                            if (e.data === YT.PlayerState.ENDED) { backdropImg.style.opacity = '1'; cleanup(); }
                        }
                    }
                });
                clickOverlay.onclick = () => player.getPlayerState() === 1 ? player.pauseVideo() : player.playVideo();
                videoAdded = true;
            }
        }

        if (videoAdded) {
            newSlide.appendChild(videoContainer);
            if (localData) {
                 setTimeout(() => { 
                     if(isHovering) {
                         backdropImg.style.opacity = '0';
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
    fetch('list.txt?' + new Date().getTime())
        .then(response => response.ok ? response.text() : null)
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

// Bound explicitly to Right Button navigation
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
                initOrResume();
                attachButtonListeners();
            }
            return
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
        initOrResume();
        attachButtonListeners();
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

    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') {
            fetchRandomMovie();
        }
        else if (e.key === 'ArrowLeft') {
            navigatePrevious();
        }
        else if (e.key === 'Enter') {
            if (document.activeElement && document.activeElement.tagName === 'BUTTON') return;
            e.stopPropagation();
            if (window.currentMovie && window.currentMovie.Id) {
                playMovie(window.currentMovie.Id);
            }
        }
        else if (e.key === 'ArrowDown') {
            // Escape iframe: Push focus down to the first media card in Jellyfin
            if (window.parent) {
                const section0 = window.parent.document.querySelector('.section0');
                const nextCard = section0 ? section0.querySelector('.card, .itemAction, .emby-button') : null;
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
        else if (e.keyCode === 10009) {
            if (window.parent) {
                const parentDoc = window.parent.document;

                // Create a clone of the keydown event (Modern Tizen/Browsers)
                const clonedEvent = new KeyboardEvent('keydown', {
                    key: e.key,
                    keyCode: e.keyCode,
                    code: e.code,
                    which: e.keyCode,
                    bubbles: true,
                    cancelable: true
                });

                // Dispatch it on the parent window so Jellyfin handles it natively
                parentDoc.dispatchEvent(clonedEvent);
            }
        }
    });

    document.body.addEventListener('mouseenter', () => {
        isHovering = true;
        if (trailerHoverTimeout) clearTimeout(trailerHoverTimeout);
        trailerHoverTimeout = setTimeout(() => {
            if (isHovering && currentTrailerStarter) currentTrailerStarter();
        }, 300);
    });

    document.body.addEventListener('mousemove', () => {
        // Fallback: sometimes iframe mouseenter is finicky
        if (!isHovering) {
            isHovering = true;
            if (trailerHoverTimeout) clearTimeout(trailerHoverTimeout);
            trailerHoverTimeout = setTimeout(() => {
                if (isHovering && currentTrailerStarter) currentTrailerStarter();
            }, 300);
        }
    });

    document.body.addEventListener('mouseleave', () => {
        isHovering = false;
        if (trailerHoverTimeout) clearTimeout(trailerHoverTimeout);
        cleanup();
        updateVolumeButtonVisibility(false);
        const backdrop = document.querySelector('.backdrop');
        if (backdrop) backdrop.style.opacity = '1';
    });
};

function initVolumeControl() {
    const button = document.getElementById('volumeButton');
    const icon = button.querySelector('.material-icons');
    const slider = document.getElementById('volumeSlider');

    let muted = globalVolume === 0;

    // 🔹 Initialize slider and icon state from globalVolume
    slider.value = globalVolume * 100;
    icon.textContent = muted ? 'volume_off' : 'volume_up';

    // Toggle mute on click (ignore clicks on slider itself)
    button.addEventListener('click', e => {
        if (e.target === slider) return;
        muted = !muted;
        slider.value = muted ? 0 : globalVolume * 100 || 50; // fallback to 50 if unset
        updateVolume(parseInt(slider.value, 10));
        icon.textContent = muted ? 'volume_off' : 'volume_up';
    });

    // Adjust volume on slider input
    slider.addEventListener('input', () => {
        const vol = parseInt(slider.value, 10);
        muted = vol === 0;
        icon.textContent = muted ? 'volume_off' : 'volume_up';
        updateVolume(vol);
    });

    function updateVolume(vol) {
        globalVolume = vol / 100; // persist globally
        localStorage.setItem('spotlightVolume', String(globalVolume));

        // YouTube trailers
        if (player?.setVolume) player.setVolume(vol);

        // Local trailers
        if (localTrailerIframe?.contentWindow) {
            localTrailerIframe.contentWindow.postMessage(
                { type: 'setVolume', value: globalVolume }, '*'
            );
        }
    }
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
    // Toggle play/pause state of the YouTube player
    toggle: function () {
        if (player && typeof player.getPlayerState === 'function') {
            const state = player.getPlayerState();
            if (state === YT.PlayerState.PLAYING) {
                player.pauseVideo();
                console.log("YouTube player paused.");
            } else {
                player.playVideo();
                console.log("YouTube player playing.");
            }
        } else {
            console.warn('YouTube player is not initialized or not available.');
        }
    }
};
