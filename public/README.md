# Static Assets

Place your static files here. They are served at `/public/*`.

## Background GIF

Upload your animated GIF as `public/bg.gif`. It will be used as the full-screen background.

## Audio Tracks

Place MP3 files in `public/audio/` to enable the in-game music selector:

- `public/audio/track1.mp3` — first track (🎵)
- `public/audio/track2.mp3` — second track (🎶)
- `public/audio/track3.mp3` — third track (🎸)

The audio button cycles through: 🔇 (silence) → 🎵 → 🎶 → 🎸 → 🔇 → ...

To add or remove tracks, update the `audioTracks` and `audioLabels` arrays in `src/index.ts`.
