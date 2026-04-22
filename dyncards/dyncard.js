// dynamic-hover.js

(function() {
    const configScriptUrl = '/web/custom/ui/dyncard-config.js'; 

    function loadConfig(url, callback) {
        const script = document.createElement('script');
        script.type = 'text/javascript';
        script.src = url;

        script.onload = () => {
            console.log('Dynamic Backgrounds: Config loaded successfully.');
            callback();
        };

        script.onerror = () => {
            console.error('Dynamic Backgrounds: Failed to load config from', url);
        };

        document.head.appendChild(script);
    }

    function initPlugin() {
        if (!window.dynamicBackgrounds) {
            console.error("Dynamic Backgrounds: Config loaded, but window.dynamicBackgrounds is empty.");
            return;
        }

        const dynamicStyleBlock = document.createElement('style');
        dynamicStyleBlock.id = "random-hover-plugin-styles";
        document.head.appendChild(dynamicStyleBlock);

        function applyRandomBackgrounds() {
            const cards = document.querySelectorAll('.card:not(.random-bg-applied)');

            cards.forEach(card => {
                // Find the image container inside the card
                const imageContainer = card.querySelector('.cardImageContainer');

                // If it doesn't exist, mark card as processed and skip
                if (!imageContainer) {
                    card.classList.add('random-bg-applied');
                    return;
                }

                // Grab the aria-label (usually the media title)
                const label = imageContainer.getAttribute('aria-label');

                if (label && window.dynamicBackgrounds[label]) {
                    const pairs = window.dynamicBackgrounds[label];
                    const randomPair = pairs[Math.floor(Math.random() * pairs.length)];
                    const uniqueClass = `dyn-hover-${Math.random().toString(36).substr(2, 9)}`;
                    const sheet = dynamicStyleBlock.sheet;

                    if (randomPair.default) {
                        sheet.insertRule(`
                            .${uniqueClass} .cardImageContainer {
                                background-image: url("${randomPair.default}") !important;
                            }
                        `, sheet.cssRules.length);
                    }

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
                        .${uniqueClass}.show-animation:focus .cardImageContainer::after {
                            opacity: 1;
                            transform: scale(1.05);
                        }
                    `, sheet.cssRules.length);

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
