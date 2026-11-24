# Mode Shift

Load a MIDI file, shift the music into another mode (major → mixolydian, minor → dorian, …), and play it in the browser.

- Detects the key and mode, including key changes, and shifts each section in its own key.
- Each note keeps its scale degree: the 3rd of the old mode becomes the 3rd of the new one. Drums are never shifted.
- Switch between the original and shifted versions while it plays, and download the shifted MIDI.
- Plays with the FluidR3 General MIDI samples from [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts), or a built-in synth.

No build step: open `index.html` or serve the folder with any static server.
