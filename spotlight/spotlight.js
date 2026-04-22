// Create an iframe and inject the Spotlight HTML/CSS
(async function () {
    const htmlUrl = "spotlight.html";
    const cssUrl = "spotlight.css";
    const jsHeadUrl = "spotlight-head.js";
    const jsBodyUrl = "spotlight-body.js";

    // Helper to Wait for the Home Library section to load
    const waitForElement = (selector) => {
        return new Promise(resolve => {
            if (document.querySelector(selector)) return resolve(document.querySelector(selector));
            const observer = new MutationObserver(() => {
                if (document.querySelector(selector)) {
                    observer.disconnect();
                    resolve(document.querySelector(selector));
                }
            });
            // Observe body for changes until our target appears
            observer.observe(document.body, { childList: true, subtree: true });
        });
    };

    const checkAndInject = async () => {
        const targetSection = await waitForElement(".section0"); // "section0" is usually the "My Media" library row
        if (document.getElementById("spotlight-iframe")) return; // Prevent duplicate injection
        console.log("Spotlight: Injecting Interface...");

        // Create the Iframe
        const iframe = document.createElement("iframe");
        iframe.id = "spotlight-iframe";
        iframe.className = "spotlightiframe focusable emby-button";
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

        // Insert iframe BEFORE the library list
        targetSection.parentNode.insertBefore(iframe, targetSection);

        // Fetch and Write Content
        try {
            const [htmlRes, cssRes, jsHeadRes, jsBodyRes] = await Promise.all([fetch(htmlUrl), fetch(cssUrl), fetch(jsHeadUrl), fetch(jsBodyUrl)]);
            if (!htmlRes.ok || !cssRes.ok || !jsHeadRes.ok || !jsBodyRes.ok) throw new Error("Failed to load Spotlight files");
            let htmlContent = await htmlRes.text();

            const headText = await jsHeadRes.text();
            const bodyText = await jsBodyRes.text();
            const cssText = await cssRes.text();

            htmlContent = htmlContent.replace(
                `<script src="spotlight-head.js"></script>`,
                () => `<script>\n${headText}\n</script>`
            );
            htmlContent = htmlContent.replace(
                `<script src="spotlight-body.js"></script>`,
                () => `<script>\n${bodyText}\n</script>`
            );
            htmlContent = htmlContent.replace(
                `<link rel="stylesheet" href="spotlight.css">`,
                () => `<style>\n${cssText}\n</style>`
            );

            // Write to the Iframe (Same-Origin)
            // Writing to "about:blank" allows the iframe to access window.parent (your Jellyfin Auth)
            const doc = iframe.contentWindow.document;
            doc.open();
            doc.write(htmlContent);
            doc.close();
            console.log("Spotlight: Injection Complete");

        } catch (error) {
            console.error("Spotlight: Error loading plugin", error);
            iframe.remove();
        }
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
