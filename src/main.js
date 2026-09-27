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

  function getVideoJsVrProjection(player, root, video) {
    let vr = null;

    try {
      if (player && typeof player.vr === 'function') {
        vr = player.vr();
      }
    } catch {
      // Some old plugin versions can throw while the player is still starting.
    }

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

  const videoJsVrAdapter = {
    name: 'videojs-vr',

    match(eventTarget) {
      if (!(eventTarget instanceof Element)) {
        return null;
      }

      const button = eventTarget.closest('.vjs-button-vr');
      if (!button) {
        return null;
      }

      const root = button.closest('.video-js');
      const video =
          root?.querySelector('video') ||
          button.closest('video') ||
          document.querySelector('.video-js video');

      if (!(video instanceof HTMLVideoElement)) {
        return null;
      }

      const player = getVideoJsPlayer(root, video);
      const projection = getVideoJsVrProjection(player, root, video);

      return {
        adapter: this,
        button,
        root,
        video,
        player,
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
