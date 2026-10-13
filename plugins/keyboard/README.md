# Local Keyboard plugin

Vendored from `@capacitor/keyboard@7.0.1` (MIT). The native sources and
`dist/esm` runtime/type declarations are copied from the published package.
The upstream repository is https://github.com/ionic-team/capacitor-plugins,
at commit `927f549a995118acd8e5735835300c4c3cbf3de7`.

The app depends on this directory through `file:plugins/keyboard`. Edit the
files here, then run `npx cap update android` and rebuild the Android app.
There is no separate JavaScript build step for this local copy. JavaScript
entry points use explicit `.js` extensions for ES module resolution.

Android adds `keyboardHeightChanged`, with `{keyboardHeight}` in density-independent
pixels, on each change reported by the system IME animation. Zero means hidden.
The final height is also reported when the animation ends. The existing
will/did events remain available, and the animation callback is removed when
the plugin is destroyed. The iOS implementation is unchanged.

Monoid disables `resizeOnFullScreen`, keeps the WebView and popup backdrop at
full height, and uses this event to move the app content with the keyboard.
