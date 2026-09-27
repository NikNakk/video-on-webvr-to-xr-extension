# WebVR Video to XR extension

A small Manifest V3 compatibility extension for legacy WebVR video players.

The extension does **not** implement immersive video rendering itself. Instead,
it adapts old player UI/state to the browser-owned immersive video path in the
macOS Chromium/OpenXR work.

## Current adapter

### videojs-vr

When the user presses either classic videojs-vr's `.vjs-button-vr` control or the WebXR fork's detached Three.js `#VRButton`, the extension:

1. finds the underlying `HTMLVideoElement`;
2. reads videojs-vr's resolved projection from `player.vr().currentProjection_`
   (with older configuration fallbacks);
3. maps that projection to Chromium's generic `data-xr-projection` hint;
4. requests fullscreen on the real `<video>` while the click still has user
   activation;
5. suppresses videojs-vr's old Cardboard/WebVR handler, so its generated
   side-by-side WebGL canvas is not used as the XR source.

If fullscreen is rejected, the extension restores the page and replays the
original VR-button click so the legacy fallback still works.

Supported videojs-vr projections:

- `360`, `Sphere`, `equirectangular`
- `360_LR`
- `360_TB`
- `180_MONO`
- `180` / `180_LR`
- `180_TB`
- `EAC`
- `EAC_LR`

`360_CUBE` / `Cube` is deliberately left to the original player for now
because the native immersive-video path does not yet have the corresponding
plain cubemap reprojection.

## Chromium requirement

This is intended for the `macos-openxr-webxr` Chromium branch. Enable:

```text
OpenXR
ImmersiveVideoPlaybackViaOpenXr
```

or launch with:

```sh
--enable-features=OpenXR,ImmersiveVideoPlaybackViaOpenXr
```

The browser-side contract is deliberately player-independent. Before a spatial
video is made fullscreen, a page or extension can set:

```html
<video data-xr-projection="360">
```

Supported values are:

```text
360
360_LR
360_TB
180_MONO
180
180_LR
180_TB
EAC
EAC_LR
```

Container spatial metadata still takes precedence over the DOM hint.

## Install for development

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select this repository directory.
6. Reload an already-open test page after installing/updating the extension.

The content script runs in the page's **MAIN** JavaScript world so it can read
the actual videojs-vr player/plugin instance rather than trying to infer its
projection from the rendered canvas.

## Structure

```text
manifest.json
src/main.js
```

`src/main.js` contains a small adapter list. videojs-vr is the first adapter;
other legacy WebVR video players can be added without changing Chromium.

## Diagnostics

Open DevTools and filter the console for:

```text
[WebVR video -> XR]
```

Useful Chromium verbose-log lines include:

```text
Using data-xr-projection immersive media hint
Requesting internal immersive-vr session
```
