// dynamic-hover.js

(function() {
    const configScriptUrl = 'dyncard-config.js';

    function loadConfig(url, callback) {
        fetch(url)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }
                // Automatically parse the response as JSON
                return response.json();
            })
            .then(data => {
                // Assign the parsed JSON data directly to your window variable
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

        const hoverVideo = document.createElement('video');
        hoverVideo.id = 'tizen-hover-video';
        hoverVideo.muted = true;
        hoverVideo.loop = true;
        hoverVideo.setAttribute('playsinline', 'true');
        hoverVideo.style.cssText = `
            position: fixed;
            z-index: 9999;
            display: none;
            pointer-events: none;
            object-fit: cover;
            border-radius: inherit;
        `;
        document.body.appendChild(hoverVideo);

        function playHoverVideo(e) {
            const card = e.currentTarget;
            const rect = card.getBoundingClientRect();

            // 1. Pause the Spotlight video when focusing a card
            const spotlightVideo = document.getElementById('tizen-hardware-video');
            if (spotlightVideo && !spotlightVideo.paused) {
                spotlightVideo.pause();
                // Tag the video so we know dyncard paused it, not the user
                spotlightVideo.dataset.pausedByDyncard = 'true';
            }

            // 2. Position the shared hover video
            hoverVideo.style.top = `${rect.top}px`;
            hoverVideo.style.left = `${rect.left}px`;
            hoverVideo.style.width = `${rect.width}px`;
            hoverVideo.style.height = `${rect.height}px`;
            hoverVideo.style.display = 'block';

            // 3. Load and play
            if (hoverVideo.src !== card.dataset.hoverVideo) {
                hoverVideo.src = card.dataset.hoverVideo;
            }
            hoverVideo.play().catch(err => console.error("Hover playback failed", err));
        }

        function stopHoverVideo(e) {
            hoverVideo.pause();
            hoverVideo.style.display = 'none';
            hoverVideo.src = '';

            // 4. Check where focus went after leaving the card
            setTimeout(() => {
                const active = document.activeElement;
                // Check if focus returned to the spotlight iframe or its wrapper
                const isTrailerFocused = active && (active.id === 'spotlight-iframe' || active.closest('#spotlight-wrapper-tizen'));

                const spotlightVideo = document.getElementById('tizen-hardware-video');

                if (isTrailerFocused && spotlightVideo && spotlightVideo.dataset.pausedByDyncard === 'true') {
                    spotlightVideo.play().catch(err => console.error("Spotlight resume failed", err));
                    spotlightVideo.dataset.pausedByDyncard = 'false';
                }
            }, 50); // 50ms delay allows Tizen's spatial navigation to update document.activeElement
        }

        function applyRandomBackgrounds() {
            const cards = document.querySelectorAll('.card:not(.random-bg-applied)');

            cards.forEach(card => {
                const imageContainer = card.querySelector('.cardImageContainer');

                // If it doesn't exist, mark card as processed and skip
                if (!imageContainer) {
                    card.classList.add('random-bg-applied');
                    return;
                }

                // Grab the aria-label (usually the media title)
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

                    // ONLY insert hover rules if a hover image exists in the config
                    if (randomPair.hover) {
                        // 1. Check if the hover asset is a video file
                        if (randomPair.hover.match(/\.(mp4|webm|mkv)$/i)) {
                            card.dataset.hoverVideo = randomPair.hover;
                            card.addEventListener('mouseenter', playHoverVideo);
                            card.addEventListener('focus', playHoverVideo);
                            card.addEventListener('mouseleave', stopHoverVideo);
                            card.addEventListener('blur', stopHoverVideo);
                        }
                        // 2. ELSE: It is a standard image, so use your existing CSS injection
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
