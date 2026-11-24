// Mode Shift core: MIDI parsing, mode detection, pitch mapping, MIDI writing.
// Pure functions, no DOM. Works in the browser (window.ModeShift) and in Node (require).
(function (root) {
  'use strict';

  // Seven-note scales, intervals from the tonic in semitones.
  // The church modes come first, ordered from brightest to darkest.
  const MODES = [
    { id: 'lydian', name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11], church: true },
    { id: 'ionian', name: 'Ionian', alias: 'major', steps: [0, 2, 4, 5, 7, 9, 11], church: true },
    { id: 'mixolydian', name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10], church: true },
    { id: 'dorian', name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10], church: true },
    { id: 'aeolian', name: 'Aeolian', alias: 'natural minor', steps: [0, 2, 3, 5, 7, 8, 10], church: true },
    { id: 'phrygian', name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10], church: true },
    { id: 'locrian', name: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10], church: true },
    { id: 'harmonic-minor', name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
    { id: 'melodic-minor', name: 'Melodic minor', steps: [0, 2, 3, 5, 7, 9, 11] },
    { id: 'lydian-dominant', name: 'Lydian dominant', steps: [0, 2, 4, 6, 7, 9, 10] },
    { id: 'phrygian-dominant', name: 'Phrygian dominant', steps: [0, 1, 4, 5, 7, 8, 10] },
    { id: 'hungarian-minor', name: 'Hungarian minor', steps: [0, 2, 3, 6, 7, 8, 11] },
    { id: 'double-harmonic', name: 'Double harmonic', steps: [0, 1, 4, 5, 7, 8, 11] },
  ];
  const MODE_BY_ID = Object.fromEntries(MODES.map(m => [m.id, m]));
  const DETECT_MODE_IDS = ['ionian', 'mixolydian', 'dorian', 'aeolian', 'phrygian', 'lydian', 'locrian', 'harmonic-minor'];

  // Preferred spelling of each tonic: [letter index (C=0..B=6), accidental]
  const TONIC_SPELLING = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [3, 1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
  const ACC = { '-2': '𝄫', '-1': '♭', '0': '', '1': '♯', '2': '𝄪' };

  function tonicName(pc) {
    const [l, a] = TONIC_SPELLING[pc];
    return LETTERS[l] + ACC[a];
  }

  // Spell a scale so each letter appears once, e.g. F lydian -> F G A B C D E.
  function spellScale(tonicPc, steps) {
    const [l0] = TONIC_SPELLING[tonicPc];
    return steps.map((s, i) => {
      const l = (l0 + i) % 7;
      const pc = (tonicPc + s) % 12;
      let acc = pc - LETTER_PC[l];
      acc = ((acc + 18) % 12) - 6;
      return Math.abs(acc) <= 2 ? LETTERS[l] + ACC[acc] : tonicName(pc);
    });
  }

  // Scale-degree labels relative to major: dorian -> 1 2 ♭3 4 5 6 ♭7
  function degreeLabels(steps) {
    const major = MODE_BY_ID.ionian.steps;
    return steps.map((s, i) => {
      const d = s - major[i];
      return (d < 0 ? '♭'.repeat(-d) : '♯'.repeat(d)) + (i + 1);
    });
  }

  // ---------------------------------------------------------------- MIDI parsing

  function readVLQ(b, q, end) {
    let v = 0, c;
    do {
      c = b[q++];
      v = (v << 7) | (c & 0x7f);
    } while ((c & 0x80) && q < end);
    return [v, q];
  }

  const KIND_RANK = { tempo: 0, keysig: 0, program: 1, cc: 2, off: 3, on: 4 };

  function parseMidi(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const str = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    const u32 = o => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const u16 = o => (b[o] << 8) | b[o + 1];

    let start = 0;
    if (b.length >= 4 && str(0) === 'RIFF') {
      // RMID wrapper: find the MThd chunk inside
      for (let i = 12; i < b.length - 4; i++) if (str(i) === 'MThd') { start = i; break; }
    }
    if (b.length < 14 || str(start) !== 'MThd') throw new Error('This is not a Standard MIDI file (no MThd header).');
    const format = u16(start + 8), ntrks = u16(start + 10), division = u16(start + 12);
    let p = start + 8 + u32(start + 4);

    const events = [];
    const trackNames = [];
    let keySignature = null, timeSignature = null;
    let order = 0, track = 0;
    while (track < ntrks && p + 8 <= b.length) {
      const id = str(p);
      const end = Math.min(p + 8 + u32(p + 4), b.length);
      if (id !== 'MTrk') { p = end; continue; }
      let q = p + 8, tick = 0, status = 0;
      while (q < end) {
        let delta;
        [delta, q] = readVLQ(b, q, end);
        tick += delta;
        let s = b[q];
        if (s & 0x80) {
          q++;
          if (s < 0xf0) status = s;
        } else {
          s = status;
          if (!s) break; // corrupt track: data byte without a status
        }
        if (s === 0xff) {
          const type = b[q++];
          let len;
          [len, q] = readVLQ(b, q, end);
          if (type === 0x51 && len >= 3) {
            events.push({ tick, kind: 'tempo', uspq: (b[q] << 16) | (b[q + 1] << 8) | b[q + 2], order: order++ });
          } else if (type === 0x03 && trackNames[track] === undefined) {
            trackNames[track] = new TextDecoder('latin1').decode(b.subarray(q, q + len)).trim();
          } else if (type === 0x59 && len >= 2) {
            const ks = { sf: (b[q] << 24) >> 24, minor: b[q + 1] === 1 };
            if (!keySignature) keySignature = ks;
            events.push({ tick, kind: 'keysig', ...ks, order: order++ });
          } else if (type === 0x58 && len >= 2 && !timeSignature) {
            timeSignature = [b[q], 1 << b[q + 1]];
          }
          q += len;
        } else if (s === 0xf0 || s === 0xf7) {
          let len;
          [len, q] = readVLQ(b, q, end);
          q += len;
        } else if (s >= 0xf1) {
          // system common/realtime bytes don't belong in files; skip the byte
        } else {
          const hi = s & 0xf0, ch = s & 0x0f;
          const off = q;
          const d1 = b[q++];
          const d2 = (hi === 0xc0 || hi === 0xd0) ? 0 : b[q++];
          if (hi === 0x90 && d2 > 0) events.push({ tick, kind: 'on', ch, pitch: d1, vel: d2, off, track, order: order++ });
          else if (hi === 0x80 || hi === 0x90) events.push({ tick, kind: 'off', ch, pitch: d1, off, track, order: order++ });
          else if (hi === 0xb0) events.push({ tick, kind: 'cc', ch, cc: d1, value: d2, order: order++ });
          else if (hi === 0xc0) events.push({ tick, kind: 'program', ch, program: d1, order: order++ });
        }
      }
      p = end;
      track++;
    }

    events.sort((x, y) => x.tick - y.tick || KIND_RANK[x.kind] - KIND_RANK[y.kind] || x.order - y.order);

    // ticks -> seconds
    let secPerTick;
    const smpte = division & 0x8000;
    if (smpte) {
      const fps = 256 - (division >> 8);
      secPerTick = 1 / ((fps === 29 ? 29.97 : fps) * (division & 0xff));
    } else {
      secPerTick = 500000 / 1e6 / division;
    }
    let firstTempo = null;
    let lastTick = 0, lastSec = 0;
    const tempoMap = [{ tick: 0, sec: 0, secPerTick }];
    const keySignatures = [];
    for (const e of events) {
      lastSec += (e.tick - lastTick) * secPerTick;
      lastTick = e.tick;
      e.sec = lastSec;
      if (e.kind === 'tempo' && !smpte) {
        secPerTick = e.uspq / 1e6 / division;
        if (firstTempo === null) firstTempo = 60e6 / e.uspq;
        tempoMap.push({ tick: e.tick, sec: e.sec, secPerTick });
      } else if (e.kind === 'keysig') {
        const prev = keySignatures[keySignatures.length - 1];
        if (!prev || prev.sf !== e.sf || prev.minor !== e.minor) keySignatures.push({ sec: e.sec, sf: e.sf, minor: e.minor });
      }
    }

    // Pair note-ons with note-offs, honoring the sustain pedal.
    const program = new Array(16).fill(0);
    const volume = new Array(16).fill(100);
    const expression = new Array(16).fill(127);
    const pan = new Array(16).fill(64);
    const pedal = new Array(16).fill(false);
    const held = Array.from({ length: 16 }, () => []); // released while the pedal was down
    const active = new Map();
    const notes = [];
    let endSec = 0;
    for (const e of events) {
      endSec = Math.max(endSec, e.sec);
      if (e.kind === 'program') program[e.ch] = e.program;
      else if (e.kind === 'cc') {
        if (e.cc === 7) volume[e.ch] = e.value;
        else if (e.cc === 11) expression[e.ch] = e.value;
        else if (e.cc === 10) pan[e.ch] = e.value;
        else if (e.cc === 64) {
          const down = e.value >= 64;
          if (pedal[e.ch] && !down) {
            for (const n of held[e.ch]) n.end = e.sec;
            held[e.ch] = [];
          }
          pedal[e.ch] = down;
        }
      } else if (e.kind === 'on') {
        // Re-striking a pitch that rings on under the pedal cuts the old one.
        const h = held[e.ch];
        for (let i = h.length - 1; i >= 0; i--) {
          if (h[i].pitch === e.pitch) { h[i].end = e.sec; h.splice(i, 1); }
        }
        const n = {
          pitch: e.pitch, vel: e.vel, ch: e.ch, track: e.track, start: e.sec, end: null,
          program: program[e.ch], gain: (volume[e.ch] / 127) * (expression[e.ch] / 127), pan: (pan[e.ch] - 64) / 64,
          onOff: e.off, offOff: -1,
        };
        notes.push(n);
        const key = e.ch * 128 + e.pitch;
        if (!active.has(key)) active.set(key, []);
        active.get(key).push(n);
      } else if (e.kind === 'off') {
        const list = active.get(e.ch * 128 + e.pitch);
        const n = list && list.shift();
        if (!n) continue;
        n.offOff = e.off;
        n.end = e.sec;
        if (pedal[e.ch] && e.ch !== 9) held[e.ch].push(n);
      }
    }
    for (const n of notes) {
      if (n.end === null) n.end = endSec;
      if (n.end - n.start < 0.03) n.end = n.start + (n.ch === 9 ? 0.1 : 0.03);
    }
    for (const h of held) for (const n of h) n.end = Math.max(n.end, endSec);
    notes.sort((x, y) => x.start - y.start || x.pitch - y.pitch);
    const duration = notes.reduce((m, n) => Math.max(m, n.end), 0);

    return {
      bytes: b, format, trackCount: track, division, notes, duration,
      bpm: firstTempo || (smpte ? null : 120), trackNames, keySignature, keySignatures, timeSignature,
      tempoMap: smpte ? null : tempoMap,
      ticksPerBar: smpte ? null : (division * 4 * (timeSignature ? timeSignature[0] / timeSignature[1] : 1)),
    };
  }

  // -------------------------------------------------------------- mode detection

  function pearson(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }

  // Template for a mode: scale tones weigh in, the tonic most, then the fifth and third.
  function modeProfile(steps) {
    const p = new Array(12).fill(0);
    for (const s of steps) p[s] = 1;
    p[0] = 2.4;
    if (steps.includes(7)) p[7] += 0.8;
    if (steps.includes(4)) p[4] += 0.45;
    else if (steps.includes(3)) p[3] += 0.45;
    return p;
  }

  // Every candidate key, with its profile rotated to absolute pitch classes.
  const KEYS = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const id of DETECT_MODE_IDS) {
      const rel = modeProfile(MODE_BY_ID[id].steps);
      KEYS.push({ tonic, mode: id, profile: rel.map((_, i) => rel[(i - tonic + 12) % 12]) });
    }
  }

  function noteWeight(n) {
    const w = 0.5 + n.vel / 254;
    return n.pitch < 55 ? w * 1.5 : w; // bass notes tend to state roots
  }

  function majorSet(ks) {
    const major = ((ks.sf * 7) % 12 + 12) % 12;
    return { major, set: new Set(MODE_BY_ID.ionian.steps.map(s => (major + s) % 12)) };
  }

  function activeKeySignature(song, t) {
    const list = song.keySignatures || [];
    let ks = song.keySignature || null;
    for (const k of list) if (k.sec <= t + 0.01) ks = k;
    return ks;
  }

  // Ranked key guesses for the whole song, or for the notes starting in [range.start, range.end).
  function detectKey(song, range) {
    const from = range ? range.start : -Infinity, to = range ? range.end : Infinity;
    const pitched = song.notes.filter(n => n.ch !== 9 && n.start >= from && n.start < to);
    if (!pitched.length) return [];
    const hist = new Array(12).fill(0);
    for (const n of pitched) hist[n.pitch % 12] += Math.min(n.end - n.start, 2) * noteWeight(n);
    // The lowest note sounding at the very end is a strong tonic hint.
    const lastEnd = pitched.reduce((m, n) => Math.max(m, n.end), 0);
    const finalNotes = pitched.filter(n => n.end >= lastEnd - 0.25);
    const finalBass = finalNotes.reduce((lo, n) => (n.pitch < lo.pitch ? n : lo), finalNotes[0]).pitch % 12;

    const ks = activeKeySignature(song, range ? range.start : 0);
    let ksTonic = null, ksSet = null;
    if (ks) {
      const { major, set } = majorSet(ks);
      ksTonic = ks.minor ? (major + 9) % 12 : major;
      ksSet = set;
    }

    const results = [];
    for (const k of KEYS) {
      const mode = MODE_BY_ID[k.mode];
      let score = pearson(hist, k.profile);
      if (finalBass === k.tonic) score += 0.12;
      if (ksTonic === k.tonic) score += 0.06;
      if (ksSet && mode.church && mode.steps.every(s => ksSet.has((k.tonic + s) % 12))) score += 0.04;
      if (k.mode === 'harmonic-minor') score -= 0.03; // prefer the plain modes on a tie
      results.push({ tonic: k.tonic, mode: k.mode, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 6);
  }

  // Start times of analysis units: whole bars (grouped so a unit lasts at least 1.5 s), ending with the duration.
  function unitBounds(song) {
    const dur = song.duration;
    const times = [];
    if (song.tempoMap && song.ticksPerBar) {
      const tm = song.tempoMap;
      let j = 0;
      for (let tick = 0; times.length < 20000; tick += song.ticksPerBar) {
        while (j + 1 < tm.length && tm[j + 1].tick <= tick) j++;
        const sec = tm[j].sec + (tick - tm[j].tick) * tm[j].secPerTick;
        if (sec >= dur) break;
        times.push(sec);
      }
    } else {
      for (let t = 0; t < dur; t += 2) times.push(t);
    }
    const out = [];
    const minLen = Math.max(1.5, dur / 3000); // keeps very long files to a few thousand units
    for (const t of times) if (!out.length || t - out[out.length - 1] >= minLen) out.push(t);
    out.push(dur);
    return out;
  }

  // Split the song where the key changes. Returns [{ start, end, key: {tonic, mode}, guesses }] covering the song.
  // Each bar gets a key score from the notes around it; a Viterbi pass picks the best key path,
  // paying `penalty` for every change, so only sustained changes become new sections.
  function detectSections(song, opts = {}) {
    const penalty = opts.penalty ?? 2.5, win = opts.window ?? 2, minUnits = opts.minUnits ?? 4;
    const pitched = song.notes.filter(n => n.ch !== 9);
    if (!pitched.length) return [];
    const b = unitBounds(song);
    const U = b.length - 1, K = KEYS.length;
    const unitAt = t => {
      let lo = 0, hi = U - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid] <= t) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const hists = Array.from({ length: U }, () => new Float64Array(12));
    for (const n of pitched) {
      const w = noteWeight(n);
      for (let u = unitAt(n.start); u < U && b[u] < n.end; u++) {
        const ov = Math.min(n.end, b[u + 1]) - Math.max(n.start, b[u]);
        if (ov > 0) hists[u][n.pitch % 12] += Math.min(ov, 2) * w;
      }
    }
    // Explicit key-signature changes in the file nudge the path when there are several.
    const ksSets = (song.keySignatures || []).length > 1 ? b.slice(0, U).map(t => majorSet(activeKeySignature(song, t)).set) : null;

    const em = new Float64Array(U * K);
    const local = new Float64Array(12);
    for (let u = 0; u < U; u++) {
      local.fill(0);
      for (let v = Math.max(0, u - win); v <= Math.min(U - 1, u + win); v++) {
        for (let i = 0; i < 12; i++) local[i] += hists[v][i];
      }
      if (!local.some(x => x > 0)) continue;
      for (let k = 0; k < K; k++) {
        let e = pearson(local, KEYS[k].profile);
        if (ksSets && MODE_BY_ID[KEYS[k].mode].church && MODE_BY_ID[KEYS[k].mode].steps.every(s => ksSets[u].has((KEYS[k].tonic + s) % 12))) e += 0.05;
        em[u * K + k] = e;
      }
    }

    let score = em.slice(0, K);
    const back = new Int16Array(U * K);
    for (let u = 1; u < U; u++) {
      let best = 0;
      for (let k = 1; k < K; k++) if (score[k] > score[best]) best = k;
      const next = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        const stay = score[k], jump = score[best] - penalty;
        if (stay >= jump) { next[k] = stay + em[u * K + k]; back[u * K + k] = k; }
        else { next[k] = jump + em[u * K + k]; back[u * K + k] = best; }
      }
      score = next;
    }
    const labels = new Int16Array(U);
    let k = 0;
    for (let i = 1; i < K; i++) if (score[i] > score[k]) k = i;
    for (let u = U - 1; u >= 0; u--) { labels[u] = k; k = back[u * K + k]; }

    let runs = [];
    for (let u = 0; u < U; u++) {
      const last = runs[runs.length - 1];
      if (last && last.k === labels[u]) last.u1 = u;
      else runs.push({ u0: u, u1: u, k: labels[u] });
    }
    // Fold runs that are too short to be a real section into a neighbor.
    for (;;) {
      if (runs.length < 2) break;
      let shortest = -1;
      for (let i = 0; i < runs.length; i++) {
        const len = runs[i].u1 - runs[i].u0 + 1;
        if (len < minUnits && (shortest < 0 || len < runs[shortest].u1 - runs[shortest].u0 + 1)) shortest = i;
      }
      if (shortest < 0) break;
      const r = runs[shortest];
      const prev = runs[shortest - 1], next = runs[shortest + 1];
      const into = !prev ? next : !next ? prev : (prev.u1 - prev.u0 >= next.u1 - next.u0 ? prev : next);
      into.u0 = Math.min(into.u0, r.u0);
      into.u1 = Math.max(into.u1, r.u1);
      runs.splice(shortest, 1);
    }

    // Name each section from its own notes, then join neighbors that came out in the same key.
    const sections = [];
    for (const r of runs) {
      const start = r.u0 === 0 ? 0 : b[r.u0], end = b[r.u1 + 1];
      const guesses = detectKey(song, { start, end });
      const top = guesses[0] || KEYS[r.k];
      const key = { tonic: top.tonic, mode: top.mode };
      const last = sections[sections.length - 1];
      if (last && last.key.tonic === key.tonic && last.key.mode === key.mode) last.end = end;
      else sections.push({ start, end, key, guesses });
    }
    for (const s of sections) s.guesses = detectKey(song, { start: s.start, end: s.end });
    sections[sections.length - 1].end = Math.max(sections[sections.length - 1].end, song.duration);
    return sections;
  }

  // ------------------------------------------------------------------ pitch map

  // policy for notes outside the source scale: 'keep' | 'below' | 'above'
  function buildPitchMap(src, tgt, policy) {
    const s = MODE_BY_ID[src.mode].steps, t = MODE_BY_ID[tgt.mode].steps;
    const transpose = ((tgt.tonic - src.tonic + 18) % 12) - 6; // nearest direction, -6..5
    const rel = new Array(12);
    for (let r = 0; r < 12; r++) {
      const i = s.indexOf(r);
      if (i >= 0) { rel[r] = t[i] - s[i]; continue; }
      if (policy === 'below') {
        let j = 0;
        for (let k = 0; k < 7; k++) if (s[k] < r) j = k;
        rel[r] = t[j] - s[j];
      } else if (policy === 'above') {
        let j = 7;
        for (let k = 6; k >= 0; k--) if (s[k] > r) j = k;
        rel[r] = j === 7 ? 0 : t[j] - s[j];
      } else rel[r] = 0;
    }
    const map = new Int16Array(128);
    for (let p = 0; p < 128; p++) {
      const r = ((p - src.tonic) % 12 + 12) % 12;
      let q = p + rel[r] + transpose;
      while (q < 0) q += 12;
      while (q > 127) q -= 12;
      map[p] = q;
    }
    return map;
  }

  // Copy the original file bytes, rewriting only the pitch byte of each note event.
  // `map` is a pitch table (index = old pitch) or a function note -> new pitch.
  function rewriteMidi(song, map) {
    const pitchOf = typeof map === 'function' ? map : n => map[n.pitch];
    const out = new Uint8Array(song.bytes);
    for (const n of song.notes) {
      if (n.ch === 9) continue;
      const q = pitchOf(n);
      out[n.onOff] = q;
      if (n.offOff >= 0) out[n.offOff] = q;
    }
    return out;
  }

  // ---------------------------------------------------------------- MIDI writer

  function vlq(v) {
    const bytes = [v & 0x7f];
    while ((v >>= 7)) bytes.unshift((v & 0x7f) | 0x80);
    return bytes;
  }

  // tracks: arrays of [tick, ...eventBytes]
  function writeMidi(tracks, ppq) {
    const out = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, ppq >> 8, ppq & 0xff];
    for (const evs of tracks) {
      const sorted = evs.map((e, i) => [e, i]).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).map(x => x[0]);
      const data = [];
      let last = 0;
      for (const [tick, ...bytes] of sorted) {
        data.push(...vlq(tick - last), ...bytes);
        last = tick;
      }
      data.push(0, 0xff, 0x2f, 0);
      const len = data.length;
      out.push(0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...data);
    }
    return new Uint8Array(out);
  }

  // A short original tune in C major with melody, arpeggiated piano, bass and drums.
  function makeDemoMidi() {
    const PPQ = 480, Q = PPQ, BAR = 4 * Q;
    const name = s => { const t = new TextEncoder().encode(s); return [0xff, 0x03, t.length, ...t]; };
    const conductor = [
      [0, ...name('Morning Walk')],
      [0, 0xff, 0x51, 3, 0x08, 0xb9, 0x25], // 105 bpm
      [0, 0xff, 0x58, 4, 4, 2, 24, 8],
      [0, 0xff, 0x59, 2, 0, 0],
    ];
    const pitch = s => {
      const m = /^([A-G])([#b]?)(-?\d)$/.exec(s);
      return 12 * (+m[3] + 1) + LETTER_PC[LETTERS.indexOf(m[1])] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    };
    const note = (evs, ch, tick, p, len, vel) => {
      evs.push([tick, 0x90 | ch, p, vel], [tick + len - 10, 0x80 | ch, p, 0]);
    };

    // melody: [note, beats]
    const tune = [
      'E5 1', 'D5 1', 'C5 1', 'G4 1', 'A4 1', 'C5 1', 'E5 2', 'F5 1', 'E5 1', 'D5 1', 'C5 1', 'D5 1.5', 'B4 0.5', 'G4 2',
      'E5 1', 'G5 1', 'E5 1', 'C5 1', 'B4 1', 'E5 1', 'G5 2', 'A5 1', 'G5 1', 'F5 1', 'D5 1', 'C5 3', 'R 1',
      'G5 0.5', 'F5 0.5', 'E5 1', 'C5 1', 'E5 1', 'F5 0.5', 'E5 0.5', 'D5 1', 'A4 1', 'D5 1', 'E5 0.5', 'D5 0.5', 'C5 1', 'G4 1', 'C5 1', 'A4 1', 'C5 1', 'G4 2',
      'B4 1', 'D5 1', 'G5 1', 'F5 1', 'E5 1', 'D5 1', 'C5 1', 'B4 1', 'A4 0.5', 'B4 0.5', 'C5 1', 'D5 1', 'B4 1', 'C5 4',
    ];
    // one chord per bar, or two per bar when written "F|G"
    const chords = ['C', 'Am', 'F', 'G', 'C', 'Em', 'F|G', 'C', 'C', 'Dm', 'Am', 'F|C', 'G', 'Am|Em', 'F|G', 'C'];
    const CHORD = {
      C: ['C3', 'E4', 'G4', 'C5'], Am: ['A2', 'E4', 'A4', 'C5'], F: ['F2', 'F4', 'A4', 'C5'], G: ['G2', 'D4', 'G4', 'B4'],
      Em: ['E3', 'E4', 'G4', 'B4'], Dm: ['D3', 'D4', 'F4', 'A4'],
    };
    const melody = [[0, ...name('Melody')], [0, 0xc0, 73]];
    let t = 0;
    for (const item of tune) {
      const [n, beats] = item.split(' ');
      const len = Math.round(+beats * Q);
      if (n !== 'R') note(melody, 0, t, pitch(n), len, 96);
      t += len;
    }
    const piano = [[0, ...name('Piano')], [0, 0xc1, 0], [0, 0xb1, 7, 82]];
    const bass = [[0, ...name('Bass')], [0, 0xc2, 33], [0, 0xb2, 7, 108]];
    chords.forEach((c, bar) => {
      const parts = c.split('|');
      parts.forEach((ch, k) => {
        const start = bar * BAR + k * (BAR / parts.length);
        const span = BAR / parts.length;
        const [root, ...upper] = CHORD[ch];
        note(bass, 2, start, pitch(root), Math.min(span, 2 * Q), 100);
        if (span === BAR) note(bass, 2, start + 2.5 * Q, pitch(root) + 7, Q, 84);
        for (let e = 0; e < span / (Q / 2); e++) {
          const order = [0, 1, 2, 1];
          note(piano, 1, start + e * (Q / 2), pitch(upper[order[e % 4]]) - 12, Q / 2, e % 2 ? 58 : 70);
        }
      });
    });
    const drums = [[0, ...name('Drums')]];
    for (let bar = 0; bar < chords.length; bar++) {
      for (let e = 0; e < 8; e++) {
        const tick = bar * BAR + e * (Q / 2);
        note(drums, 9, tick, 42, Q / 4, e % 2 ? 52 : 70);
        if (e === 0 || e === 5) note(drums, 9, tick, 36, Q / 2, 104);
        if (e === 2 || e === 6) note(drums, 9, tick, 38, Q / 2, 88);
      }
    }
    note(drums, 9, 16 * BAR, 49, Q * 2, 90);
    note(drums, 9, 16 * BAR, 36, Q, 104);
    return writeMidi([conductor, melody, piano, bass, drums], PPQ);
  }

  const api = {
    MODES, MODE_BY_ID, tonicName, spellScale, degreeLabels,
    parseMidi, detectKey, detectSections, buildPitchMap, rewriteMidi, writeMidi, makeDemoMidi,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ModeShift = api;
})(typeof window !== 'undefined' ? window : globalThis);
