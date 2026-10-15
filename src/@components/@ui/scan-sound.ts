const FADE_IN_SECONDS = 0.18;
const FADE_OUT_SECONDS = 0.24;

let encodedSound: Promise<ArrayBuffer> | undefined;

function loadEncodedSound(): Promise<ArrayBuffer> {
  encodedSound ??= fetch(
    new URL('../../@assets/scan-prompt.wav', import.meta.url),
  )
    .then(async response => {
      if (!response.ok) {
        throw new Error('Could not load scan sound');
      }

      return response.arrayBuffer();
    })
    .catch(error => {
      encodedSound = undefined;
      throw error;
    });

  return encodedSound;
}

/** Play the stereo cue once, fading out early when the card disconnects. */
export function createScanSound(
  context: BaseAudioContext,
  buffer: AudioBuffer,
): {
  stop: () => void;
  ended: Promise<void>;
} {
  const output = context.createGain();
  const source = context.createBufferSource();
  const now = context.currentTime;

  output.gain.setValueAtTime(0, now);
  output.gain.linearRampToValueAtTime(1, now + FADE_IN_SECONDS);
  output.connect(context.destination);
  source.buffer = buffer;
  source.connect(output);

  let stopped = false;

  const ended = new Promise<void>(resolve => {
    source.onended = () => {
      stopped = true;
      source.disconnect();
      output.disconnect();
      resolve();
    };
  });

  source.start(now);

  return {
    ended,
    stop: () => {
      if (stopped) {
        return;
      }

      stopped = true;
      const now = context.currentTime;
      const end = now + FADE_OUT_SECONDS;

      // Preserve the current level even if a quick read ends during fade-in.
      output.gain.cancelAndHoldAtTime(now);
      // Anchor release here; a completed attack is otherwise the last ramp point.
      output.gain.setValueAtTime(output.gain.value, now);
      output.gain.linearRampToValueAtTime(0, end);

      source.stop(end);
    },
  };
}

/** Playback is optional feedback: it must never hold up a card operation. */
export function playScanSound(): () => void {
  if (document.hidden || typeof AudioContext === 'undefined') {
    return () => {};
  }

  let context: AudioContext | undefined;
  let sound: ReturnType<typeof createScanSound> | undefined;
  let stopped = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const close = (): void => {
    clearTimeout(closeTimer);

    if (context && context.state !== 'closed') {
      void context.close().catch(() => {});
    }
  };

  const stop = (): void => {
    if (stopped) {
      return;
    }

    stopped = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    sound?.stop();

    if (!sound || document.hidden || context?.state !== 'running') {
      close();
    } else {
      // Also close if an audio interruption prevents the scheduled end event.
      closeTimer = setTimeout(close, FADE_OUT_SECONDS * 1000 + 50);
    }
  };

  const onVisibilityChange = (): void => {
    if (document.hidden) {
      stop();
    }
  };

  document.addEventListener('visibilitychange', onVisibilityChange);

  try {
    const audioContext = (context = new AudioContext());

    void Promise.all([audioContext.resume(), loadEncodedSound()])
      .then(async ([, data]) => {
        if (stopped) {
          return;
        }

        // Decoding may detach its input; keep the cached bytes reusable.
        const buffer = await audioContext.decodeAudioData(data.slice(0));

        if (stopped) {
          return;
        }

        if (document.hidden || audioContext.state !== 'running') {
          stop();
          return;
        }

        sound = createScanSound(audioContext, buffer);
        void sound.ended.then(() => {
          stop();
          close();
        });
      })
      .catch(stop);
  } catch {
    stop();
  }

  return stop;
}
