// dynamic-hover.js

(function() {
    const configScriptUrl = 'dyncard-config.js';

    function loadConfig(url, callback) {
        fetch(url)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                window.dynamicBackgrounds = data;
                console.log('Dynamic Backgrounds: Remote JSON config loaded successfully.');
                callback();
            })
            .catch(error => {
                console.error('Dynamic Backgrounds: Failed to fetch remote config from', url, error);
            });
    }

    function initPlugin() {
        if (!window.dynamicBackgrounds) {
            console.error("Dynamic Backgrounds: Config loaded, but window.dynamicBackgrounds is empty.");
            return;
        }

        const dynamicStyleBlock = document.createElement('style');
        dynamicStyleBlock.id = "dyn-tv-styles";
        document.head.appendChild(dynamicStyleBlock);

        // --- 1. SETUP SINGLETON HARDWARE PLAYER ---
        const oldVid = document.getElementById('tizen-hover-video');
        if (oldVid) oldVid.remove();

        const hoverVideo = document.createElement('video');
        hoverVideo.id = 'tizen-hover-video';
        hoverVideo.muted = true;
        hoverVideo.loop = true;
        hoverVideo.setAttribute('playsinline', 'true');
        hoverVideo.style.cssText = `
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            z-index: 5;
            display: none;
            pointer-events: none;
            object-fit: cover;
            border-radius: inherit;
        `;

        let hoverIntentTimeout = null;
        let activeImageContainer = null;

        function playHoverVideo(e) {
            const card = e.currentTarget;
            const imageContainer = card.querySelector('.cardImageContainer');
            if (!imageContainer) return;

            if (hoverIntentTimeout) clearTimeout(hoverIntentTimeout);

            // Wait 600ms for UI movements to stabilize
            hoverIntentTimeout = setTimeout(() => {
                if (document.activeElement !== card && !card.matches(':hover')) return;

                // Pause Spotlight to free the hardware decoder
                const spotlightVideo = document.getElementById('tizen-hardware-video');
                if (spotlightVideo && !spotlightVideo.paused) {
                    spotlightVideo.pause();
                    spotlightVideo.dataset.pausedByDyncard = 'true';
                }

                // Inject video INSIDE the card
                if (hoverVideo.parentNode !== imageContainer) {
                    imageContainer.appendChild(hoverVideo);
                }
                activeImageContainer = imageContainer;

                // HIDE the CSS background image so the video is visible
                if (imageContainer.style.backgroundImage !== 'none') {
                    imageContainer.dataset.originalBg = imageContainer.style.backgroundImage;
                    imageContainer.style.backgroundImage = 'none';
                }

                // Force clipping to rounded borders via translateZ
                imageContainer.style.transform = 'translateZ(0)';
                imageContainer.style.overflow = 'hidden';

                hoverVideo.style.display = 'block';

                if (hoverVideo.src !== card.dataset.hoverVideo) {
                    hoverVideo.src = card.dataset.hoverVideo;
                }
                hoverVideo.play().catch(err => console.error("Hover playback failed", err));

            }, 50);
        }

        function stopHoverVideo(e) {
            if (hoverIntentTimeout) clearTimeout(hoverIntentTimeout);

            hoverVideo.pause();
            hoverVideo.style.display = 'none';

            // RESTORE the CSS background image and clean up transforms
            if (activeImageContainer) {
                if (activeImageContainer.dataset.originalBg) {
                    activeImageContainer.style.backgroundImage = activeImageContainer.dataset.originalBg;
                }
                activeImageContainer.style.transform = '';
                activeImageContainer = null;
            }

            // Resume Spotlight
            setTimeout(() => {
                const active = document.activeElement;
                const isTrailerFocused = active && (active.id === 'spotlight-iframe' || active.closest('#spotlight-wrapper-tizen'));
                const spotlightVideo = document.getElementById('tizen-hardware-video');

                if (isTrailerFocused && spotlightVideo && spotlightVideo.dataset.pausedByDyncard === 'true') {
                    spotlightVideo.play().catch(err => console.error("Spotlight resume failed", err));
                    spotlightVideo.dataset.pausedByDyncard = 'false';
                }
            }, 50);
        }

        function applyRandomBackgrounds() {
            const cards = document.querySelectorAll('.card:not(.random-bg-applied)');
            cards.forEach(card => {
                const imageContainer = card.querySelector('.cardImageContainer');
                if (!imageContainer) {
                    card.classList.add('random-bg-applied');
                    return;
                }

                let label = card.getAttribute('aria-label');
                if (label && window.dynamicBackgrounds[label]) {
                    const pairs = window.dynamicBackgrounds[label];
                    const randomPair = pairs[Math.floor(Math.random() * pairs.length)];
                    const uniqueClass = `tizen-${Math.random().toString(36).substr(2, 5)}`;
                    const sheet = dynamicStyleBlock.sheet;

                    if (randomPair.default) {
                        sheet.insertRule(`
                            .${uniqueClass} .cardImageContainer {
                                background-image: url("${randomPair.default}") !important;
                            }
                        `, sheet.cssRules.length);
                    }

                    if (randomPair.hover) {
                        // 1. Hardware Video Handling
                        if (randomPair.hover.match(/\.(mp4|webm|mkv)$/i)) {
                            card.dataset.hoverVideo = randomPair.hover;
                            card.addEventListener('mouseenter', playHoverVideo);
                            card.addEventListener('focus', playHoverVideo);
                            card.addEventListener('mouseleave', stopHoverVideo);
                            card.addEventListener('blur', stopHoverVideo);
                        } 
                        // 2. Standard Image Handling (Fallback to CSS)
                        else {
                            sheet.insertRule(`
                                .${uniqueClass} .cardImageContainer::after {
                                    content: "";
                                    background-image: url("${randomPair.hover}");
                                    background-size: contain;
                                    background-repeat: no-repeat;
                                    background-position: center;
                                    opacity: 0;
                                    transition: opacity 0.3s ease, transform 0.3s ease;
                                    position: absolute;
                                    top: 0; left: 0; width: 100%; height: 100%;
                                    pointer-events: none;
                                }
                            `, sheet.cssRules.length);
                            sheet.insertRule(`
                                .${uniqueClass}:hover .cardImageContainer::after,
                                .${uniqueClass}:focus-within .cardImageContainer::after,
                                .${uniqueClass}.show-animation:focus .cardImageContainer::after {
                                    opacity: 1;
                                    transform: scale(1.05);
                                }
                            `, sheet.cssRules.length);
                        }
                    }
                    card.classList.add(uniqueClass, 'random-bg-applied');
                } else {
                    card.classList.add('random-bg-applied');
                }
            });
        }

        const observer = new MutationObserver(() => applyRandomBackgrounds());
        observer.observe(document.body, { childList: true, subtree: true });
    }

    loadConfig(configScriptUrl, initPlugin);
})();
