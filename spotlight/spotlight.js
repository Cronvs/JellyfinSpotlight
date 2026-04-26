// Create an iframe and inject the Spotlight HTML/CSS
(async function () {
    // Helper to wait for the ACTIVE (visible) Home Library section to load
    const waitForVisibleElement = (selector) => {
        return new Promise(resolve => {
            // Find an element that is currently visible on screen (offsetParent !== null)
            const getVisible = () => Array.from(document.querySelectorAll(selector)).find(el => el.offsetParent !== null);

            if (getVisible()) return resolve(getVisible());

            const observer = new MutationObserver(() => {
                const visibleEl = getVisible();
                if (visibleEl) {
                    observer.disconnect();
                    resolve(visibleEl);
                }
            });
            // Observe body for changes until our target appears
            observer.observe(document.body, { childList: true, subtree: true });
        });
    };

    const checkAndInject = async () => {
        // Wait specifically for the visible section0 in the active page view
        const targetSection = await waitForVisibleElement(".section0");
        const existingWrapper = document.getElementById("spotlight-wrapper-tizen");

        if (existingWrapper) {
            if (existingWrapper.nextElementSibling === targetSection) return;
            existingWrapper.remove();
        }

        console.log("Spotlight: Injecting Interface natively (Tizen Wrapper)...");

        // Create a wrapper to hold BOTH the iframe and the parent-level video
        const wrapper = document.createElement('div');
        wrapper.id = 'spotlight-wrapper-tizen';
        wrapper.style.cssText = `
            position: relative;
            width: 100%;
            height: 75vh;
            min-height: 75vh;
            max-height: 90vh;
            aspect-ratio: 7/4;
            margin: -8.5em auto -55px auto;
            overflow: hidden;
        `;

        const iframe = document.createElement("iframe");
        iframe.id = "spotlight-iframe";
        iframe.className = "spotlightiframe focusable emby-button";
        iframe.tabIndex = 0;
        iframe.allow = "autoplay; fullscreen";
        iframe.allowTransparency = "true";
        iframe.style.cssText = `
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            border: 0; outline: none;
            background: transparent;
            z-index: 2; /* Keep iframe text above the video */
        `;
        iframe.src = "spotlight.html";

        wrapper.appendChild(iframe);
        targetSection.parentNode.insertBefore(wrapper, targetSection);
        console.log("Spotlight: Injection Complete");
    };

    // Run immediately
    checkAndInject();

    // Re-run when internal navigation occurs
    const pushState = history.pushState;
    history.pushState = function () {
        pushState.apply(history, arguments);
        setTimeout(checkAndInject, 500);
    };
    window.addEventListener("popstate", () => setTimeout(checkAndInject, 500));
})();
