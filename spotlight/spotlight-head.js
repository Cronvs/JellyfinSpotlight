document.addEventListener('DOMContentLoaded', () => {
    window.addEventListener("message", (e) => {
        if (e.data === "local-trailer-ended") {
            console.log("📼 Local trailer ended, advancing slide.");
            cleanup();
            fetchNextMovie();
        }
    });
    const parentStyles = getComputedStyle(window.parent.document.documentElement);
    const root = document.documentElement;
    const fallbackColors = {
        '--md-sys-color-primary': '#239dfb',
        '--md-sys-color-primary-container': '#0032570D', // 95% transp
        '--md-sys-color-on-primary': '#003257',
        '--md-sys-color-on-primary-container': '#e9ddff',
        '--md-sys-color-outline': '#67656a', // darker gray
        '--color-text-body': '#e6e1e6'
    };

    Object.entries(fallbackColors).forEach(([name, fallback]) => {
        const val = parentStyles.getPropertyValue(name).trim() || fallback;
        root.style.setProperty(name, val);
    });
});

// Load and initialize YouTube Iframe API
let youTubeAPIReadyPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
        console.log("YouTube Iframe API already loaded.");
        resolve(window.YT);
    } else {
        window.onYouTubeIframeAPIReady = function () {
            console.log("YouTube Iframe API is ready.");
            resolve(window.YT);
        };

        if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
            const tag = document.createElement('script');
            tag.src = "https://www.youtube.com/iframe_api";
            const firstScriptTag = document.getElementsByTagName('script')[0];
            firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
            console.log("YouTube Iframe API script added.");
        } else {
            console.log("YouTube Iframe API script already present.");
        }

        setTimeout(() => {
            reject(new Error("YouTube Iframe API failed to load within expected time."));
        }, 10000);
    }
});