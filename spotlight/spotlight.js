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

        const existingIframe = document.getElementById("spotlight-iframe");

        if (existingIframe) {
            if (existingIframe.nextElementSibling === targetSection) return;
            existingIframe.remove();
        }

        console.log("Spotlight: Injecting Interface...");

        // Create the Iframe
        const iframe = document.createElement("iframe");
        iframe.id = "spotlight-iframe";
        iframe.className = "spotlightiframe";
        iframe.tabIndex = 0;

        // Position the iframe in the dashboard
        iframe.style.cssText = `
            width: 100%;
            min-height: 75vh;
            max-height: 90vh;
            aspect-ratio: 7/4;
            display: block;
            border: 0;
            margin: -8.5em auto -55px auto; 
            overflow: hidden;
            outline: none;
        `;

        iframe.src = "/web/custom/ui/spotlight.html";

        // Insert iframe BEFORE the active library list
        targetSection.parentNode.insertBefore(iframe, targetSection);
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
