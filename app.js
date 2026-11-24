(() => {
  'use strict';
  const M = window.ModeShift;
  const $ = id => document.getElementById(id);

  // General MIDI program names as used by the gleitz/midi-js-soundfonts files.
  const GM = ('acoustic_grand_piano bright_acoustic_piano electric_grand_piano honkytonk_piano electric_piano_1 electric_piano_2 harpsichord clavinet ' +
    'celesta glockenspiel music_box vibraphone marimba xylophone tubular_bells dulcimer drawbar_organ percussive_organ rock_organ church_organ ' +
    'reed_organ accordion harmonica tango_accordion acoustic_guitar_nylon acoustic_guitar_steel electric_guitar_jazz electric_guitar_clean ' +
    'electric_guitar_muted overdriven_guitar distortion_guitar guitar_harmonics acoustic_bass electric_bass_finger electric_bass_pick fretless_bass ' +
    'slap_bass_1 slap_bass_2 synth_bass_1 synth_bass_2 violin viola cello contrabass tremolo_strings pizzicato_strings orchestral_harp timpani ' +
    'string_ensemble_1 string_ensemble_2 synth_strings_1 synth_strings_2 choir_aahs voice_oohs synth_choir orchestra_hit trumpet trombone tuba ' +
    'muted_trumpet french_horn brass_section synth_brass_1 synth_brass_2 soprano_sax alto_sax tenor_sax baritone_sax oboe english_horn bassoon ' +
    'clarinet piccolo flute recorder pan_flute blown_bottle shakuhachi whistle ocarina lead_1_square lead_2_sawtooth lead_3_calliope lead_4_chiff ' +
    'lead_5_charang lead_6_voice lead_7_fifths lead_8_bass__lead pad_1_new_age pad_2_warm pad_3_polysynth pad_4_choir pad_5_bowed pad_6_metallic ' +
    'pad_7_halo pad_8_sweep fx_1_rain fx_2_soundtrack fx_3_crystal fx_4_atmosphere fx_5_brightness fx_6_goblins fx_7_echoes fx_8_scifi sitar banjo ' +
    'shamisen koto kalimba bagpipe fiddle shanai tinkle_bell agogo steel_drums woodblock taiko_drum melodic_tom synth_drum reverse_cymbal ' +
    'guitar_fret_noise breath_noise seashore bird_tweet telephone_ring helicopter applause gunshot').split(' ');
  const SF_BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/';
  const prettyProgram = p => GM[p].replace(/__/g, ' ').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

  const DEFAULT_TARGET = { ionian: 'mixolydian', aeolian: 'dorian', mixolydian: 'ionian', dorian: 'aeolian', lydian: 'ionian', phrygian: 'aeolian', locrian: 'phrygian' };

  const state = {
    song: null, fileName: '', isDemo: false,
    sections: [],         // [{ start, end, key: {tonic, mode}, guesses }], covering the song
    followChanges: true,  // false: one key for the whole piece
    tgtMode: 'mixolydian',
    shift: 0,             // target tonic = section tonic + shift (semitones, 0..11)
    policy: 'keep', listen: 'shifted', maps: [],
    current: -1,          // index of the section under the playhead
    lo: 36, hi: 84, viewStart: 0, pxPerSec: 90,
  };
  const tgtKey = i => ({ tonic: (state.sections[i].key.tonic + state.shift) % 12, mode: state.tgtMode });
  const mapped = n => state.maps[n.si][n.pitch];

  // ------------------------------------------------------------------ setup UI

  function fillTonics(sel) {
    for (let pc = 0; pc < 12; pc++) sel.add(new Option(M.tonicName(pc), pc));
  }
  function fillModes(sel) {
    for (const m of M.MODES) sel.add(new Option(m.alias ? `${m.name} (${m.alias})` : m.name, m.id));
  }
  fillTonics($('tgtTonic'));

  (function buildModeChips() {
    const groups = [
      { label: 'Church modes', note: 'brightest → darkest', modes: M.MODES.filter(m => m.church) },
      { label: 'Other scales', note: '', modes: M.MODES.filter(m => !m.church) },
    ];
    const root = $('tgtModes');
    for (const g of groups) {
      const div = document.createElement('div');
      div.className = 'modegroup';
      div.innerHTML = `<div class="label"><span>${g.label}</span><span>${g.note}</span></div><div class="modelist"></div>`;
      const list = div.querySelector('.modelist');
      for (const m of g.modes) {
        const lab = document.createElement('label');
        lab.className = 'mode';
        lab.dataset.mode = m.id;
        lab.innerHTML = `<input type="radio" name="tgtMode" id="tgt-${m.id}" value="${m.id}"><span>${m.name}${m.alias ? `<small>${m.alias}</small>` : ''}</span>`;
        list.append(lab);
      }
      root.append(div);
    }
  })();

  // ------------------------------------------------------------------ loading

  function showMessage(text) {
    $('message').textContent = text;
    $('message').hidden = !text;
  }

  function detectSections() {
    const song = state.song;
    if (state.followChanges) return M.detectSections(song);
    const guesses = M.detectKey(song);
    return [{ start: 0, end: song.duration, key: { tonic: guesses[0].tonic, mode: guesses[0].mode }, guesses }];
  }

  function setSections(sections) {
    state.sections = sections;
    // tag every note with the section its onset falls in
    let i = 0;
    for (const n of state.song.notes) {
      while (i + 1 < sections.length && n.start >= sections[i + 1].start) i++;
      n.si = i;
    }
    state.current = -1;
    renderSections();
  }

  function loadBytes(bytes, name, isDemo) {
    let song;
    try {
      song = M.parseMidi(bytes);
    } catch (e) {
      showMessage(`Couldn't read “${name}”: ${e.message}`);
      return;
    }
    if (!song.notes.some(n => n.ch !== 9)) {
      showMessage(`“${name}” has no pitched notes to shift (only drums, or empty).`);
      return;
    }
    showMessage('');
    stopPlayback();
    player.songStart = 0;
    state.song = song;
    state.fileName = name;
    state.isDemo = isDemo;
    state.viewStart = 0;
    state.shift = 0;
    setSections(detectSections());
    const firstMode = state.sections[0].key.mode;
    if (state.tgtMode === firstMode) state.tgtMode = DEFAULT_TARGET[firstMode] || 'ionian';
    renderSong();
    recompute();
    $('play').disabled = $('rewind').disabled = $('download').disabled = false;
    loadInstrumentsForSong();
  }

  $('file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, false);
    e.target.value = '';
  });
  $('demo').addEventListener('click', () => loadBytes(M.makeDemoMidi(), 'Morning Walk', true));

  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('drop').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault();
    dragDepth = 0;
    $('drop').hidden = true;
    const f = e.dataTransfer.files[0];
    if (f) loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, false);
  });

  // ------------------------------------------------------------------ rendering

  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const keyLabel = k => `${M.tonicName(k.tonic)} ${M.MODE_BY_ID[k.mode].name.toLowerCase()}`;

  function renderSong() {
    const s = state.song;
    const title = s.trackNames[0] && s.format === 1 && s.trackNames[0].length < 60 && !state.isDemo ? `${state.fileName} · ${s.trackNames[0]}` : state.fileName;
    $('songName').textContent = title;
    $('demoTag').hidden = !state.isDemo;
    const pitched = s.notes.filter(n => n.ch !== 9);
    const programs = new Set(pitched.map(n => n.program));
    const parts = [
      fmtTime(s.duration),
      s.bpm ? `${Math.round(s.bpm)} bpm` : null,
      `${s.trackCount} track${s.trackCount === 1 ? '' : 's'}`,
      `${pitched.length.toLocaleString('en-US')} notes`,
      `${programs.size} instrument${programs.size === 1 ? '' : 's'}`,
    ].filter(Boolean);
    $('songMeta').textContent = parts.join(' · ');
  }

  // The list of sections, each with its own editable source key.
  function renderSections() {
    const list = $('sections');
    list.innerHTML = '';
    const many = state.sections.length > 1;
    state.sections.forEach((sec, i) => {
      const li = document.createElement('li');
      li.className = 'section';
      li.innerHTML = `<button type="button" class="when" title="Jump here">${many ? fmtTime(sec.start) + '–' + fmtTime(sec.end) : 'Whole piece'}</button>
        <select id="sec-${i}-tonic" aria-label="Section ${i + 1} tonic"></select>
        <select id="sec-${i}-mode" aria-label="Section ${i + 1} mode"></select>`;
      const [btn, tonicSel, modeSel] = li.children;
      fillTonics(tonicSel);
      fillModes(modeSel);
      tonicSel.value = sec.key.tonic;
      modeSel.value = sec.key.mode;
      btn.addEventListener('click', () => seek(sec.start + 0.001));
      tonicSel.addEventListener('change', () => setSectionKey(i, { ...sec.key, tonic: +tonicSel.value }));
      modeSel.addEventListener('change', () => setSectionKey(i, { ...sec.key, mode: modeSel.value }));
      list.append(li);
    });
    $('followChanges').value = state.followChanges ? 'yes' : 'no';
  }

  function sectionAt(t) {
    const secs = state.sections;
    let i = 0;
    while (i + 1 < secs.length && t >= secs[i + 1].start) i++;
    return i;
  }

  // Everything that describes "the section under the playhead": key names, guesses, degree ladder.
  function renderCurrent(force) {
    if (!state.sections.length) return;
    const i = sectionAt(songTime());
    if (i === state.current && !force) return;
    state.current = i;
    const sec = state.sections[i], many = state.sections.length > 1;
    const tgt = tgtKey(i);
    [...$('sections').children].forEach((li, j) => li.classList.toggle('current', j === i && many));
    for (const [j, s] of state.sections.entries()) {
      $(`sec-${j}-tonic`).value = s.key.tonic;
      $(`sec-${j}-mode`).value = s.key.mode;
    }
    $('srcName').textContent = keyLabel(sec.key);
    $('tgtName').textContent = keyLabel(tgt);
    $('srcWhere').textContent = many ? `Section ${i + 1} of ${state.sections.length} · ${fmtTime(sec.start)}–${fmtTime(sec.end)}` : 'Whole piece';
    $('tgtWhere').textContent = many ? (state.shift ? `Every section moves up ${state.shift} semitone${state.shift > 1 ? 's' : ''} and into ${M.MODE_BY_ID[state.tgtMode].name.toLowerCase()}.` : `Every section keeps its tonic and moves into ${M.MODE_BY_ID[state.tgtMode].name.toLowerCase()}.`) : '';
    $('tgtTonic').value = tgt.tonic;
    const radio = $(`tgt-${state.tgtMode}`);
    if (radio) radio.checked = true;
    for (const lab of document.querySelectorAll('#tgtModes .mode')) {
      lab.classList.toggle('same', lab.dataset.mode === sec.key.mode && state.shift === 0);
    }
    const g = $('guesses');
    g.innerHTML = '';
    const seen = new Set();
    for (const c of sec.guesses) {
      const k = `${c.tonic}-${c.mode}`;
      if (seen.has(k) || seen.size >= 4) continue;
      seen.add(k);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = keyLabel(c);
      b.setAttribute('aria-pressed', String(c.tonic === sec.key.tonic && c.mode === sec.key.mode));
      b.addEventListener('click', () => setSectionKey(i, { tonic: c.tonic, mode: c.mode }));
      g.append(b);
    }
    renderLadder(i);
  }

  function renderLadder(i) {
    const src = state.sections[i].key, tgt = tgtKey(i);
    const s = M.MODE_BY_ID[src.mode].steps, t = M.MODE_BY_ID[tgt.mode].steps;
    const sl = M.degreeLabels(s), tl = M.degreeLabels(t);
    const sn = M.spellScale(src.tonic, s), tn = M.spellScale(tgt.tonic, t);
    $('ladderWhere').textContent = state.sections.length > 1 ? `Section ${i + 1}: ${keyLabel(src)} → ${keyLabel(tgt)}` : '';
    $('degrees').innerHTML = s.map((_, k) => {
      const d = t[k] - s[k];
      const mid = d === 0 ? '=' : (d > 0 ? '↑' : '↓') + (Math.abs(d) === 1 ? '½' : Math.abs(d) / 2);
      return `<div class="deg${d ? ' changed' : ''}" title="${d ? (d > 0 ? 'raised' : 'lowered') + ' by ' + Math.abs(d) + ' semitone' + (Math.abs(d) > 1 ? 's' : '') : 'unchanged'}">
        <div class="src"><div class="num">${sl[k]}</div><div class="nm">${sn[k]}</div></div>
        <div class="mid">${mid}</div>
        <div class="tgt"><div class="num">${tl[k]}</div><div class="nm">${tn[k]}</div></div>
      </div>`;
    }).join('');
  }

  function renderSummary() {
    const pitched = state.song.notes.filter(n => n.ch !== 9);
    const changedCount = pitched.filter(n => mapped(n) !== n.pitch).length;
    const pct = pitched.length ? Math.round((100 * changedCount) / pitched.length) : 0;
    $('changeSummary').innerHTML = `<strong>${changedCount.toLocaleString('en-US')}</strong> of ${pitched.length.toLocaleString('en-US')} notes move (${pct}%)`;
  }

  function recompute() {
    if (!state.song) return;
    state.maps = state.sections.map((sec, i) => M.buildPitchMap(sec.key, tgtKey(i), state.policy));
    let lo = 127, hi = 0;
    for (const n of state.song.notes) {
      if (n.ch === 9) continue;
      const q = mapped(n);
      lo = Math.min(lo, n.pitch, q);
      hi = Math.max(hi, n.pitch, q);
    }
    state.lo = Math.max(0, lo - 2);
    state.hi = Math.min(127, hi + 2);
    renderCurrent(true);
    renderSummary();
    resyncSounding();
    draw();
  }

  function setSectionKey(i, key) {
    state.sections[i].key = key;
    recompute();
  }

  $('followChanges').addEventListener('change', e => {
    state.followChanges = e.target.value === 'yes';
    if (!state.song) return;
    setSections(detectSections());
    recompute();
  });
  $('tgtTonic').addEventListener('change', e => {
    const cur = Math.max(0, state.current);
    state.shift = ((+e.target.value - state.sections[cur].key.tonic) % 12 + 12) % 12;
    recompute();
  });
  $('tgtModes').addEventListener('change', e => { state.tgtMode = e.target.value; recompute(); });
  $('policy').addEventListener('change', e => { state.policy = e.target.value; recompute(); });

  function setListen(which) {
    state.listen = which;
    $('listenOrig').setAttribute('aria-pressed', String(which === 'original'));
    $('listenShifted').setAttribute('aria-pressed', String(which === 'shifted'));
    resyncSounding();
    draw();
  }
  $('listenOrig').addEventListener('click', () => setListen('original'));
  $('listenShifted').addEventListener('click', () => setListen('shifted'));

  $('download').addEventListener('click', () => {
    if (!state.song) return;
    const bytes = M.rewriteMidi(state.song, mapped);
    const base = state.fileName.replace(/\.(mid|midi|kar|rmi)$/i, '');
    const mode = M.MODE_BY_ID[state.tgtMode].name.toLowerCase();
    const tonic = M.tonicName(tgtKey(0).tonic).replace('♭', 'b').replace('♯', '#');
    const name = state.sections.length > 1 ? `${base} - ${mode}.mid` : `${base} - ${tonic} ${mode}.mid`;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  // ------------------------------------------------------------------ audio

  let ctx = null, master = null, noise = null;
  function ensureCtx() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(comp).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  const instruments = new Map(); // program -> { status, buffers: Map(midi -> AudioBuffer), pitches: sorted midi numbers }

  function noteNameToMidi(name) {
    const m = /^([A-G])(b?)(-?\d+)$/.exec(name);
    if (!m) return null;
    return 12 * (+m[3] + 1) + [0, 2, 4, 5, 7, 9, 11]['CDEFGAB'.indexOf(m[1])] - (m[2] ? 1 : 0);
  }

  async function loadInstrument(program) {
    if (instruments.has(program)) return;
    const inst = { status: 'loading', buffers: new Map(), pitches: [] };
    instruments.set(program, inst);
    renderSoundStatus();
    try {
      const res = await fetch(`${SF_BASE}${GM[program]}-mp3.js`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // The file is a script: `MIDI.Soundfont.<name> = { "A0": "data:audio/mp3;base64,...", ... }`
      const head = /MIDI\.Soundfont\.\w+\s*=\s*/.exec(text);
      if (!head) throw new Error('unexpected soundfont format');
      const body = text.slice(head.index + head[0].length, text.lastIndexOf('}') + 1);
      const json = JSON.parse(body.replace(/,\s*}$/, '}'));
      const c = ensureCtx();
      await Promise.all(Object.entries(json).map(async ([name, uri]) => {
        const midi = noteNameToMidi(name);
        if (midi === null) return;
        const bin = atob(uri.slice(uri.indexOf(',') + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        inst.buffers.set(midi, await c.decodeAudioData(bytes.buffer));
      }));
      inst.pitches = [...inst.buffers.keys()].sort((a, b) => a - b);
      inst.status = inst.pitches.length ? 'ready' : 'error';
    } catch (e) {
      console.warn('Could not load instrument', GM[program], e);
      inst.status = 'error';
    }
    renderSoundStatus();
  }

  function songPrograms() {
    return state.song ? [...new Set(state.song.notes.filter(n => n.ch !== 9).map(n => n.program))].sort((a, b) => a - b) : [];
  }

  function loadInstrumentsForSong() {
    renderSoundStatus();
    if ($('sound').value !== 'sampled') return;
    for (const p of songPrograms()) loadInstrument(p);
  }

  function renderSoundStatus() {
    const el = $('soundStatus');
    const progs = songPrograms();
    if ($('sound').value !== 'sampled' || !progs.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = progs.map(p => {
      const inst = instruments.get(p);
      const st = inst ? inst.status : 'loading';
      const label = st === 'ready' ? '<span class="ok">✓</span>' : st === 'error' ? '<span class="err">synth (couldn’t load)</span>' : 'loading…';
      return `<span>${prettyProgram(p)} ${label}</span>`;
    }).join('') + '<span>Drums: synth</span>';
  }
  $('sound').addEventListener('change', () => { loadInstrumentsForSong(); resyncSounding(); });

  const voices = new Set();

  function playedPitch(n) {
    return n.ch === 9 || state.listen === 'original' ? n.pitch : mapped(n);
  }

  function startVoice(n, when, dur) {
    const pitch = playedPitch(n);
    const amp = Math.pow(n.vel / 127, 1.6) * n.gain * 0.9;
    const out = ctx.createGain();
    let dest = out;
    if (n.pan && ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, n.pan));
      out.connect(pan);
      dest = pan;
    }
    dest.connect(master);
    const voice = { out, sources: [], end: when + dur + 1 };
    if (n.ch === 9) drumVoice(voice, n.pitch, when, amp);
    else {
      const inst = $('sound').value === 'sampled' ? instruments.get(n.program) : null;
      if (inst && inst.status === 'ready') sampleVoice(voice, inst, pitch, when, dur, amp);
      else synthVoice(voice, n.program, pitch, when, dur, amp);
    }
    voices.add(voice);
    const last = voice.sources[voice.sources.length - 1];
    if (last) last.onended = () => { voices.delete(voice); out.disconnect(); };
  }

  function sampleVoice(voice, inst, pitch, when, dur, amp) {
    let base = inst.pitches[0];
    for (const p of inst.pitches) if (Math.abs(p - pitch) < Math.abs(base - pitch)) base = p;
    const src = ctx.createBufferSource();
    src.buffer = inst.buffers.get(base);
    src.playbackRate.value = Math.pow(2, (pitch - base) / 12);
    const g = voice.out.gain;
    g.setValueAtTime(amp, when);
    g.setValueAtTime(amp, when + dur);
    g.setTargetAtTime(0, when + dur, 0.09);
    src.connect(voice.out);
    src.start(when);
    src.stop(when + dur + 0.6);
    voice.sources.push(src);
  }

  function synthVoice(voice, program, pitch, when, dur, amp) {
    const f = 440 * Math.pow(2, (pitch - 69) / 12);
    const sustained = (program >= 16 && program < 24) || (program >= 40 && program < 96 && !(program >= 45 && program <= 47));
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), o2g = ctx.createGain(), filt = ctx.createBiquadFilter();
    o1.type = 'triangle';
    o2.type = 'sawtooth';
    o1.frequency.value = f;
    o2.frequency.value = f * 1.004;
    o2g.gain.value = 0.22;
    filt.type = 'lowpass';
    filt.frequency.value = Math.min(f * 6, 9000);
    filt.Q.value = 0.4;
    o1.connect(filt);
    o2.connect(o2g).connect(filt);
    filt.connect(voice.out);
    const g = voice.out.gain;
    const peak = amp * 0.55;
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(peak, when + 0.012);
    g.setTargetAtTime(peak * (sustained ? 0.75 : 0.3), when + 0.012, sustained ? 0.3 : 0.35);
    g.setTargetAtTime(0, when + dur, 0.07);
    for (const o of [o1, o2]) { o.start(when); o.stop(when + dur + 0.5); voice.sources.push(o); }
  }

  function drumVoice(voice, key, when, amp) {
    const out = voice.out;
    const noiseHit = (type, freq, decay, level, q = 0.8) => {
      const src = ctx.createBufferSource(), filt = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = noise;
      filt.type = type;
      filt.frequency.value = freq;
      filt.Q.value = q;
      g.gain.setValueAtTime(level, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + decay);
      src.connect(filt).connect(g).connect(out);
      src.start(when, Math.random() * 0.5);
      src.stop(when + decay + 0.05);
      voice.sources.push(src);
    };
    const toneHit = (f0, f1, decay, level, type = 'sine') => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, when);
      o.frequency.exponentialRampToValueAtTime(f1, when + decay * 0.6);
      g.gain.setValueAtTime(level, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + decay);
      o.connect(g).connect(out);
      o.start(when);
      o.stop(when + decay + 0.05);
      voice.sources.push(o);
    };
    const a = amp * 1.1;
    if (key === 35 || key === 36) toneHit(150, 42, 0.32, a * 1.4);
    else if (key === 38 || key === 40 || key === 37 || key === 39) { toneHit(220, 160, 0.09, a * 0.5, 'triangle'); noiseHit('bandpass', 2000, key === 39 ? 0.12 : 0.18, a * 0.9, 0.6); }
    else if (key === 42 || key === 44) noiseHit('highpass', 7500, 0.05, a * 0.5);
    else if (key === 46) noiseHit('highpass', 7000, 0.3, a * 0.45);
    else if (key === 49 || key === 52 || key === 55 || key === 57) noiseHit('highpass', 5000, 1.3, a * 0.45);
    else if (key === 51 || key === 53 || key === 59) noiseHit('bandpass', 6500, 0.45, a * 0.35, 1.5);
    else if ([41, 43, 45, 47, 48, 50].includes(key)) { const f = 70 + (key - 41) * 14; toneHit(f * 1.6, f, 0.35, a); }
    else noiseHit('bandpass', 3200, 0.1, a * 0.5, 1.2);
  }

  function silence() {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const v of voices) {
      v.out.gain.cancelScheduledValues(now);
      v.out.gain.setTargetAtTime(0, now, 0.015);
      for (const s of v.sources) { try { s.stop(now + 0.08); } catch (e) { /* not started yet */ } }
    }
    voices.clear();
  }

  // ------------------------------------------------------------------ transport

  const player = { playing: false, ctxStart: 0, songStart: 0, idx: 0, rate: 1, timer: null };
  const LOOKAHEAD = 0.25;

  function songTime() {
    // ctxStart sits a few ms ahead of "now" when playback starts, so clamp at 0
    return player.playing ? Math.max(0, player.songStart + (ctx.currentTime - player.ctxStart) * player.rate) : player.songStart;
  }

  function firstNoteAtOrAfter(t) {
    const notes = state.song.notes;
    let lo = 0, hi = notes.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (notes[mid].start < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function play() {
    if (!state.song) return;
    ensureCtx();
    ctx.resume();
    if (player.songStart >= state.song.duration - 0.05) player.songStart = 0;
    player.playing = true;
    player.ctxStart = ctx.currentTime + 0.06;
    player.idx = firstNoteAtOrAfter(player.songStart);
    resyncSounding(true);
    clearInterval(player.timer);
    player.timer = setInterval(pump, 25);
    pump();
    updatePlayButton();
    requestAnimationFrame(frame);
  }

  function pump() {
    const notes = state.song.notes;
    const horizon = songTime() + LOOKAHEAD * player.rate;
    while (player.idx < notes.length && notes[player.idx].start < horizon) {
      const n = notes[player.idx++];
      const when = player.ctxStart + (n.start - player.songStart) / player.rate;
      startVoice(n, Math.max(when, ctx.currentTime), (n.end - n.start) / player.rate);
    }
    if (songTime() > state.song.duration + 0.4) {
      stopPlayback();
      player.songStart = 0;
      draw();
    }
  }

  function stopPlayback() {
    if (player.playing) player.songStart = Math.min(songTime(), state.song ? state.song.duration : 0);
    player.playing = false;
    clearInterval(player.timer);
    silence();
    updatePlayButton();
  }

  function seek(t) {
    if (!state.song) return;
    const was = player.playing;
    if (was) stopPlayback();
    player.songStart = Math.max(0, Math.min(t, state.song.duration));
    if (was) play();
    else { followView(true); draw(); }
  }

  // Restart notes that are ringing right now, so a change of mode or A/B is heard at once.
  function resyncSounding(onlyHeld) {
    if (!player.playing || !state.song) return;
    if (!onlyHeld) silence();
    const now = songTime();
    const notes = state.song.notes;
    const end = Math.min(player.idx, notes.length);
    for (let i = 0; i < end; i++) {
      const n = notes[i];
      if (n.ch !== 9 && n.start <= now && n.end > now + 0.05) {
        startVoice(n, ctx.currentTime + 0.01, (n.end - now) / player.rate);
      }
    }
    if (!onlyHeld) {
      // notes already scheduled ahead were silenced too: schedule them again
      player.idx = firstNoteAtOrAfter(now + 0.0001);
      player.songStart = now;
      player.ctxStart = ctx.currentTime;
    }
  }

  function updatePlayButton() {
    const playing = player.playing;
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('playIcon').innerHTML = playing ? '<path d="M6 4.5h4v15H6zM14 4.5h4v15h-4z"/>' : '<path d="M7 4.5v15l13-7.5z"/>';
  }

  $('play').addEventListener('click', () => (player.playing ? stopPlayback() : play()));
  $('rewind').addEventListener('click', () => seek(0));
  $('speed').addEventListener('input', e => {
    const rate = +e.target.value / 100;
    $('speedOut').textContent = `${e.target.value}%`;
    if (player.playing) {
      player.songStart = songTime();
      player.ctxStart = ctx.currentTime;
    }
    player.rate = rate;
  });

  document.addEventListener('keydown', e => {
    const el = e.target instanceof Element ? e.target : null;
    if (el && el.closest('input, select, textarea, button') && el.type !== 'radio' && el.type !== 'range') {
      if (!(e.code === 'Space' && el.tagName === 'BUTTON')) return;
      el.blur(); // Space on a focused button: treat it as play/pause, not a second click
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space' && state.song) {
      e.preventDefault();
      player.playing ? stopPlayback() : play();
    } else if (e.key === 'a' || e.key === 'A') {
      setListen(state.listen === 'shifted' ? 'original' : 'shifted');
    }
  });

  // ------------------------------------------------------------------ piano roll

  const roll = $('roll'), overview = $('overview');
  let colors = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['bg', 'surface', 'surface-2', 'ink', 'muted', 'line', 'accent', 'warm', 'note', 'row-in', 'row-tonic']) colors[k] = cs.getPropertyValue(`--${k}`).trim();
  }
  readColors();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); draw(); });
  new MutationObserver(() => { readColors(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function sizeCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [g, c.clientWidth, c.clientHeight];
  }
  new ResizeObserver(() => draw()).observe(roll);

  const KEY_W = 34;
  function followView(force) {
    const w = roll.clientWidth - KEY_W;
    const t = songTime();
    const span = w / state.pxPerSec;
    if (force || t < state.viewStart || t > state.viewStart + span * 0.8) {
      state.viewStart = Math.max(0, t - span * 0.2);
    }
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawRoll() {
    const [g, W, H] = sizeCanvas(roll);
    g.fillStyle = colors.surface;
    g.fillRect(0, 0, W, H);
    if (!state.song) return;
    const { lo, hi } = state;
    const rows = hi - lo + 1;
    const rowH = H / rows;
    const pps = state.pxPerSec;
    const t0 = state.viewStart;
    const t1 = t0 + (W - KEY_W) / pps;
    const X = t => KEY_W + (t - t0) * pps;
    const Y = p => H - (p - lo + 1) * rowH;
    const shifted = state.listen === 'shifted';
    const keyOf = i => (shifted ? tgtKey(i) : state.sections[i].key);
    const visible = state.sections.map((sec, i) => [sec, i]).filter(([sec]) => sec.end > t0 && sec.start < t1);

    // scale rows, per section
    for (const [sec, i] of visible) {
      const key = keyOf(i);
      const steps = new Set(M.MODE_BY_ID[key.mode].steps);
      const xa = Math.max(KEY_W, X(sec.start)), xb = Math.min(W, X(sec.end));
      for (let p = lo; p <= hi; p++) {
        const r = ((p - key.tonic) % 12 + 12) % 12;
        if (!steps.has(r)) continue;
        g.fillStyle = r === 0 ? colors['row-tonic'] : colors['row-in'];
        g.fillRect(xa, Y(p), xb - xa, rowH);
      }
    }
    // time grid: every beat when tempo is known, otherwise every second
    const beat = state.song.bpm ? 60 / state.song.bpm : 1;
    const perBar = state.song.timeSignature ? state.song.timeSignature[0] : 4;
    const step = beat * pps < 14 ? beat * perBar : beat;
    g.lineWidth = 1;
    for (let k = Math.floor(t0 / step); k * step <= t1; k++) {
      const x = Math.round(X(k * step)) + 0.5;
      const isBar = Math.round((k * step) / beat) % perBar === 0;
      g.strokeStyle = colors.line;
      g.globalAlpha = isBar ? 0.9 : 0.4;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    g.globalAlpha = 1;

    // notes
    const now = songTime();
    const notes = state.song.notes;
    let i = firstNoteAtOrAfter(Math.max(0, t0 - 10));
    const h = Math.max(2, rowH - 1.5);
    const ghosts = [], solids = [];
    for (; i < notes.length && notes[i].start < t1; i++) {
      const n = notes[i];
      if (n.ch === 9 || n.end < t0) continue;
      const q = mapped(n);
      const moved = q !== n.pitch;
      const p = shifted ? q : n.pitch;
      const x = X(n.start), w = Math.max(2, (n.end - n.start) * pps - 1);
      const lit = n.start <= now && n.end > now;
      if (moved && state.listen === 'shifted') ghosts.push([x, Y(n.pitch), w]);
      solids.push([x, Y(p), w, moved ? (state.listen === 'shifted' ? colors.accent : colors.warm) : colors.note, lit]);
    }
    g.setLineDash([3, 2]);
    g.strokeStyle = colors.warm;
    g.lineWidth = 1;
    for (const [x, y, w] of ghosts) { roundRect(g, x + 0.5, y + 1, w - 1, h - 1, 2); g.stroke(); }
    g.setLineDash([]);
    for (const [x, y, w, c, lit] of solids) {
      g.fillStyle = c;
      g.globalAlpha = lit ? 1 : 0.82;
      roundRect(g, x, y + 0.75, w, h, 2);
      g.fill();
      if (lit) { g.strokeStyle = colors.ink; g.lineWidth = 1; g.stroke(); }
    }
    g.globalAlpha = 1;

    // section boundaries, each labeled with its key change
    const monoFont = getComputedStyle(document.body).getPropertyValue('--font-mono') || 'monospace';
    if (state.sections.length > 1) {
      g.font = `600 11px ${monoFont}`;
      g.textBaseline = 'middle';
      for (const [sec, i] of visible) {
        const x = X(sec.start);
        if (i > 0 && x >= KEY_W) {
          g.fillStyle = colors.ink;
          g.fillRect(Math.round(x) - 1, 0, 2, H);
        }
        const label = `${i + 1} · ${keyLabel(sec.key)} → ${keyLabel(tgtKey(i))}`;
        const tw = g.measureText(label).width;
        const lx = Math.min(Math.max(KEY_W, x) + 6, X(sec.end) - tw - 18);
        if (lx < KEY_W + 2) continue;
        g.fillStyle = colors.surface;
        g.globalAlpha = 0.92;
        roundRect(g, lx - 5, 5, tw + 10, 18, 4);
        g.fill();
        g.globalAlpha = 1;
        g.strokeStyle = colors.line;
        g.lineWidth = 1;
        g.stroke();
        g.fillStyle = colors.ink;
        g.fillText(label, lx, 14.5);
      }
    }

    // keyboard gutter with octave labels on each C and the tonic
    g.fillStyle = colors['surface-2'];
    g.fillRect(0, 0, KEY_W, H);
    g.strokeStyle = colors.line;
    g.beginPath(); g.moveTo(KEY_W - 0.5, 0); g.lineTo(KEY_W - 0.5, H); g.stroke();
    for (let p = lo; p <= hi; p++) {
      const black = [1, 3, 6, 8, 10].includes(p % 12);
      if (black) { g.fillStyle = colors.line; g.fillRect(0, Y(p), KEY_W * 0.55, rowH); }
    }
    g.font = `600 ${Math.min(11, Math.max(8, rowH * 1.6))}px ${monoFont}`;
    const key = keyOf(sectionAt(Math.max(t0, now >= t0 && now <= t1 ? now : t0)));
    g.textBaseline = 'middle';
    let lastLabelY = Infinity;
    for (let p = lo; p <= hi; p++) {
      const r = ((p - key.tonic) % 12 + 12) % 12;
      const y = Y(p) + rowH / 2;
      if (r === 0 && lastLabelY - y > 11) {
        g.fillStyle = shifted ? colors.accent : colors.warm;
        g.fillText(`${M.tonicName(key.tonic)}${Math.floor(p / 12) - 1}`, 3, y);
        lastLabelY = y;
      }
    }

    // playhead
    const px = X(now);
    if (px >= KEY_W && px <= W) {
      g.fillStyle = colors.ink;
      g.fillRect(Math.round(px) - 1, 0, 2, H);
    }
  }

  function drawOverview() {
    const [g, W, H] = sizeCanvas(overview);
    g.fillStyle = colors['surface-2'];
    g.fillRect(0, 0, W, H);
    if (!state.song) return;
    const dur = state.song.duration || 1;
    const { lo, hi } = state;
    const X = t => (t / dur) * W;
    const Y = p => H - 3 - ((p - lo) / Math.max(1, hi - lo)) * (H - 6);
    for (const n of state.song.notes) {
      if (n.ch === 9) continue;
      const q = mapped(n);
      const moved = q !== n.pitch;
      g.fillStyle = moved ? (state.listen === 'shifted' ? colors.accent : colors.warm) : colors.note;
      const p = state.listen === 'shifted' ? q : n.pitch;
      g.fillRect(X(n.start), Y(p) - 1, Math.max(1, X(n.end) - X(n.start)), 2);
    }
    g.fillStyle = colors.ink;
    for (const sec of state.sections.slice(1)) g.fillRect(Math.round(X(sec.start)) - 1, 0, 2, H);
    const span = (roll.clientWidth - KEY_W) / state.pxPerSec;
    g.strokeStyle = colors.ink;
    g.globalAlpha = 0.5;
    g.strokeRect(X(state.viewStart) + 0.5, 0.5, Math.max(4, X(span) - 1), H - 1);
    g.globalAlpha = 1;
    g.fillStyle = colors.ink;
    g.fillRect(Math.round(X(songTime())) - 1, 0, 2, H);
  }

  function draw() {
    if (player.playing) followView(false);
    drawRoll();
    drawOverview();
    renderCurrent(false);
    const d = state.song ? state.song.duration : 0;
    $('time').textContent = `${fmtTime(Math.min(songTime(), d))} / ${fmtTime(d)}`;
  }

  function frame() {
    draw();
    if (player.playing) requestAnimationFrame(frame);
  }

  roll.addEventListener('click', e => {
    if (!state.song || rollDragged) return;
    const x = e.offsetX;
    if (x < KEY_W) return;
    seek(state.viewStart + (x - KEY_W) / state.pxPerSec);
  });
  // horizontal wheel / trackpad scroll pans the roll; ctrl/pinch zooms
  roll.addEventListener('wheel', e => {
    if (!state.song) return;
    if (e.ctrlKey) {
      e.preventDefault();
      const tAt = state.viewStart + (e.offsetX - KEY_W) / state.pxPerSec;
      state.pxPerSec = Math.max(15, Math.min(400, state.pxPerSec * Math.exp(-e.deltaY * 0.01)));
      state.viewStart = Math.max(0, tAt - (e.offsetX - KEY_W) / state.pxPerSec);
      draw();
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault();
      const d = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      state.viewStart = Math.max(0, Math.min(state.song.duration, state.viewStart + d / state.pxPerSec));
      draw();
    }
  }, { passive: false });
  // drag to pan when paused
  let rollDragged = false, dragX = null, dragView = 0;
  roll.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') { dragX = e.clientX; dragView = state.viewStart; rollDragged = false; } });
  window.addEventListener('pointermove', e => {
    if (dragX === null || !state.song) return;
    const dx = e.clientX - dragX;
    if (Math.abs(dx) > 4) rollDragged = true;
    if (rollDragged && !player.playing) {
      state.viewStart = Math.max(0, Math.min(state.song.duration, dragView - dx / state.pxPerSec));
      draw();
    }
  });
  window.addEventListener('pointerup', () => { dragX = null; setTimeout(() => { rollDragged = false; }, 0); });

  let overviewDrag = false;
  const overviewSeek = e => {
    if (!state.song) return;
    const r = overview.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * state.song.duration);
  };
  overview.addEventListener('pointerdown', e => { overviewDrag = true; overview.setPointerCapture(e.pointerId); overviewSeek(e); });
  overview.addEventListener('pointermove', e => { if (overviewDrag && !player.playing) overviewSeek(e); });
  overview.addEventListener('pointerup', e => { if (overviewDrag && player.playing) overviewSeek(e); overviewDrag = false; });

  // Open with the demo tune so the page shows what it does right away.
  loadBytes(M.makeDemoMidi(), 'Morning Walk', true);
})();
