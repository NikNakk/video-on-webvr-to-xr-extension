(() => {
  'use strict';

  const INSTALL_GUARD = '__webVrVideoToXrExtensionInstalled__';
  if (window[INSTALL_GUARD]) {
    return;
  }

  Object.defineProperty(window, INSTALL_GUARD, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const XR_PROJECTION_ATTRIBUTE = 'data-xr-projection';
  const LOG_PREFIX = '[WebVR video -> XR]';

  let replayingOriginalClick = false;
  let activeTakeover = null;

  function log(...args) {
    console.debug(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function normaliseProjection(value) {
    if (value == null) {
      return null;
    }

    const projection = String(value).trim();
    if (!projection) {
      return null;
    }

    if (/^(sphere|equirectangular)$/i.test(projection)) {
      return '360';
    }

    const upper = projection.toUpperCase();

    switch (upper) {
      case '360':
      case '360_LR':
      case '360_TB':
      case 'EAC':
      case 'EAC_LR':
      case '180':
      case '180_LR':
      case '180_TB':
      case '180_MONO':
        return upper;
      case 'AUTO':
      case 'NONE':
        return null;
      case '360_CUBE':
      case 'CUBE':
        return 'UNSUPPORTED_CUBE';
      default:
        return null;
    }
  }

  function projectionFromDataSetup(element) {
    if (!element) {
      return null;
    }

    const raw = element.getAttribute('data-setup');
    if (!raw) {
      return null;
    }

    try {
      const setup = JSON.parse(raw);
      return setup?.plugins?.vr?.projection ?? setup?.vr?.projection ?? null;
    } catch {
      return null;
    }
  }

  function getVideoJsPlayer(root, video) {
    if (video?.player) {
      return video.player;
    }

    if (root?.player) {
      return root.player;
    }

    const videojs = window.videojs;
    if (!videojs) {
      return null;
    }

    try {
      if (root?.id && typeof videojs.getPlayer === 'function') {
        const player = videojs.getPlayer(root.id);
        if (player) {
          return player;
        }
      }
    } catch {
      // Fall through to the player registry.
    }

    try {
      if (typeof videojs.getPlayers === 'function') {
        const players = videojs.getPlayers();
        for (const player of Object.values(players || {})) {
          if (!player) {
            continue;
          }

          const element =
              typeof player.el === 'function' ? player.el() : player.el_;
          if (element === root || element?.contains(video)) {
            return player;
          }
        }
      }
    } catch {
      // A bundled/private Video.js instance may not expose the global registry.
    }

    return null;
  }

  function getVrInstance(player) {
    try {
      if (player && typeof player.vr === 'function') {
        return player.vr();
      }
    } catch {
      // Some old plugin versions can throw while the player is still starting.
    }
    return null;
  }

  function getVideoJsVrProjection(player, root, video, knownVr = null) {
    const vr = knownVr || getVrInstance(player);

    const candidates = [
      vr?.currentProjection_,
      vr?.defaultProjection_,
      player?.mediainfo?.projection,
      player?.options_?.plugins?.vr?.projection,
      projectionFromDataSetup(video),
      projectionFromDataSetup(root),
      video?.getAttribute('data-projection'),
      root?.getAttribute('data-projection')
    ];

    for (const candidate of candidates) {
      const projection = normaliseProjection(candidate);
      if (projection) {
        return projection;
      }
    }

    return null;
  }

  function findPlayerForDetachedVrButton(button) {
    const videojs = window.videojs;
    if (!videojs || typeof videojs.getPlayers !== 'function') {
      return null;
    }

    try {
      const players = Object.values(videojs.getPlayers() || {}).filter(Boolean);
      let soleVrCandidate = null;
      let candidateCount = 0;

      for (const player of players) {
        const vr = getVrInstance(player);
        if (!vr) {
          continue;
        }

        // videojs-vr-xr's Three.js VRButton is appended directly to <body>,
        // but the plugin keeps the exact element on vrButton.
        if (vr.vrButton === button) {
          return {player, vr};
        }

        // Some bundled builds do not expose vrButton. If there is only one
        // active VR plugin on the page, it is still a safe fallback for the
        // globally appended #VRButton.
        if (vr.currentProjection_ || vr.defaultProjection_ || vr.renderer) {
          soleVrCandidate = {player, vr};
          candidateCount++;
        }
      }

      return candidateCount === 1 ? soleVrCandidate : null;
    } catch {
      return null;
    }
  }

  const videoJsVrAdapter = {
    name: 'videojs-vr',

    match(eventTarget) {
      if (!(eventTarget instanceof Element)) {
        return null;
      }

      // Legacy builds use several button class names. Classic videojs-vr uses
      // .vjs-button-vr, some forks/themes use .vjs-vr / .vjs-icon-vr, and the
      // WebXR fork can create a detached Three.js button with id=VRButton.
      const button = eventTarget.closest(
        '.vjs-button-vr, .vjs-vr, .vjs-icon-vr, #VRButton'
      );
      if (!button) {
        return null;
      }

      let root = button.closest('.video-js');
      let video =
          root?.querySelector('video') ||
          button.closest('video');
      let player = video instanceof HTMLVideoElement
          ? getVideoJsPlayer(root, video)
          : null;
      let vr = getVrInstance(player);

      if (button.id === 'VRButton') {
        const detached = findPlayerForDetachedVrButton(button);
        if (detached) {
          player = detached.player;
          vr = detached.vr;
          root =
              (typeof player.el === 'function' ? player.el() : player.el_) ||
              root;
          video =
              (typeof vr?.getVideoEl_ === 'function' ? vr.getVideoEl_() : null) ||
              root?.querySelector?.('video') ||
              null;
        }
      }

      if (!(video instanceof HTMLVideoElement)) {
        // Last-resort DOM fallback is intentionally only accepted when there
        // is exactly one Video.js video on the page.
        const videos = [...document.querySelectorAll('.video-js video')]
          .filter((element) => element instanceof HTMLVideoElement);
        if (videos.length === 1) {
          video = videos[0];
          root = video.closest('.video-js');
          player = player || getVideoJsPlayer(root, video);
          vr = vr || getVrInstance(player);
        }
      }

      if (!(video instanceof HTMLVideoElement)) {
        warn('videojs-vr: VR button found but underlying video could not be identified');
        return null;
      }

      const projection = getVideoJsVrProjection(player, root, video, vr);

      log('videojs-vr: intercepted VR button', {
        button: button.id || button.className,
        projection,
        detachedWebXrButton: button.id === 'VRButton'
      });

      return {
        adapter: this,
        button,
        root,
        video,
        player,
        vr,
        projection
      };
    }
  };

  const adapters = [videoJsVrAdapter];

  function restoreTakeover(state) {
    if (!state) {
      return;
    }

    const {video, previousAttribute, previousStyle} = state;

    if (previousAttribute == null) {
      video.removeAttribute(XR_PROJECTION_ATTRIBUTE);
    } else {
      video.setAttribute(XR_PROJECTION_ATTRIBUTE, previousAttribute);
    }

    video.style.opacity = previousStyle.opacity;
    video.style.zIndex = previousStyle.zIndex;
    video.style.visibility = previousStyle.visibility;
    video.style.display = previousStyle.display;

    if (activeTakeover === state) {
      activeTakeover = null;
    }
  }

  function prepareTakeover(video, projection, adapterName) {
    if (activeTakeover && activeTakeover.video !== video) {
      restoreTakeover(activeTakeover);
    }

    const state = {
      video,
      projection,
      adapterName,
      previousAttribute: video.getAttribute(XR_PROJECTION_ATTRIBUTE),
      previousStyle: {
        opacity: video.style.opacity,
        zIndex: video.style.zIndex,
        visibility: video.style.visibility,
        display: video.style.display
      }
    };

    video.setAttribute(XR_PROJECTION_ATTRIBUTE, projection);

    // videojs-vr normally hides the decoded video behind its Three.js canvas.
    // Fullscreen the real video instead; Chromium's immersive path consumes the
    // decoded frame directly, so the WebGL/Cardboard canvas is not the XR source.
    video.style.opacity = '1';
    video.style.zIndex = '';
    video.style.visibility = '';
    video.style.display = '';

    activeTakeover = state;
    return state;
  }

  function replayOriginalButton(button) {
    replayingOriginalClick = true;
    try {
      button.click();
    } finally {
      replayingOriginalClick = false;
    }
  }

  function requestNativeImmersive(context, clickEvent) {
    const {adapter, button, video, projection} = context;

    if (!projection) {
      warn(
        `${adapter.name}: could not determine projection; leaving the legacy player unchanged`
      );
      return false;
    }

    if (projection === 'UNSUPPORTED_CUBE') {
      warn(
        `${adapter.name}: 360_CUBE is not supported by the native immersive video path yet`
      );
      return false;
    }

    if (typeof video.requestFullscreen !== 'function') {
      warn(`${adapter.name}: Fullscreen API is unavailable`);
      return false;
    }

    const state = prepareTakeover(video, projection, adapter.name);

    let fullscreenPromise;
    try {
      // This call must happen synchronously inside the real user click so the
      // browser's transient user activation is still available.
      fullscreenPromise = video.requestFullscreen({navigationUI: 'hide'});
    } catch (error) {
      restoreTakeover(state);
      warn(`${adapter.name}: requestFullscreen threw`, error);
      return false;
    }

    // Only suppress videojs-vr's Cardboard/WebVR handler after the browser has
    // accepted our fullscreen request. Its generated SBS canvas never becomes
    // the source of the immersive session.
    clickEvent.preventDefault();
    clickEvent.stopImmediatePropagation();

    Promise.resolve(fullscreenPromise)
      .then(() => {
        log(
          `${adapter.name}: native immersive takeover requested (${projection})`
        );
      })
      .catch((error) => {
        warn(
          `${adapter.name}: fullscreen takeover failed; replaying the original VR button`,
          error
        );
        restoreTakeover(state);
        replayOriginalButton(button);
      });

    return true;
  }

  document.addEventListener(
    'click',
    (event) => {
      if (replayingOriginalClick || event.defaultPrevented) {
        return;
      }

      for (const adapter of adapters) {
        const context = adapter.match(event.target);
        if (!context) {
          continue;
        }

        requestNativeImmersive(context, event);
        return;
      }
    },
    true
  );

  document.addEventListener('fullscreenchange', () => {
    if (!activeTakeover) {
      return;
    }

    if (document.fullscreenElement !== activeTakeover.video) {
      log(
        `${activeTakeover.adapterName}: fullscreen ended; restoring legacy player state`
      );
      restoreTakeover(activeTakeover);
    }
  });

  log('installed');
})();
