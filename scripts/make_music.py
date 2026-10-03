# Оригинальные треки Timelapse Studio (авторские, синтез с нуля — без чужих сэмплов и прав).
import numpy as np, wave, sys
SR = 44100
rng = np.random.default_rng(7)

def note_hz(n):  # MIDI -> Гц
    return 440.0 * 2 ** ((n - 69) / 12)

def env_adsr(n, a, d, s, r, sr=SR):
    a, d, r = int(a*sr), int(d*sr), int(r*sr)
    sus = max(0, n - a - d - r)
    e = np.concatenate([np.linspace(0, 1, max(a,1)), np.linspace(1, s, max(d,1)), np.full(sus, s), np.linspace(s, 0, max(r,1))])
    return e[:n] if len(e) >= n else np.pad(e, (0, n - len(e)))

def lowpass(x, cutoff):
    # однополюсный фильтр, достаточно для «тёплого» звука
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x); acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc; y[i] = acc
    return y

def lp_fast(x, cutoff):  # быстрый вариант через свёртку
    k = int(SR / cutoff / 2) | 1
    w = np.hanning(k); w /= w.sum()
    return np.convolve(x, w, mode="same")

def hp_fast(x, cutoff):
    return x - lp_fast(x, cutoff)

def saw(f, t, detune=0.0):
    out = np.zeros_like(t)
    for d in (-detune, 0, detune):
        ff = f * (1 + d)
        kmax = max(1, int(9000 / ff))
        for k in range(1, kmax + 1):
            out += np.sin(2 * np.pi * k * ff * t) / k * (1 if k % 2 else -1)
    return out * (2 / np.pi) / 3

def tri(f, t):
    out = np.zeros_like(t)
    for i, k in enumerate(range(1, 16, 2)):
        if k * f > 12000: break
        out += ((-1) ** i) * np.sin(2 * np.pi * k * f * t) / (k * k)
    return out * 8 / np.pi ** 2

def fft_lowpass(x, cutoff, width=1500):
    X = np.fft.rfft(x); fr = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / (1 + np.exp((fr - cutoff) / (width / 6)))
    return np.fft.irfft(X, n=len(x))

def epiano(f, n):
    t = np.arange(n) / SR
    tone = np.sin(2*np.pi*f*t + 1.2*np.sin(2*np.pi*f*t)*np.exp(-t*6)) + 0.3*np.sin(2*np.pi*2*f*t)*np.exp(-t*3)
    return tone * np.exp(-t * 1.6) * 0.5

def kick(n=int(0.45*SR), punch=1.0):
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t * 28)
    ph = 2*np.pi*np.cumsum(f)/SR
    return np.sin(ph) * np.exp(-t * 7) * punch + 0.3*np.exp(-t*200)*rng.standard_normal(n)*0.2

def snare(n=int(0.3*SR), tone=200, dark=False):
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    noise = lp_fast(noise, 3500 if dark else 7000)
    return (0.6*noise*np.exp(-t*18) + 0.4*np.sin(2*np.pi*tone*t)*np.exp(-t*25))

def hat(n=int(0.08*SR), open_=False):
    t = np.arange(n if not open_ else int(0.3*SR)) / SR
    noise = hp_fast(rng.standard_normal(len(t)), 6000)
    return noise * np.exp(-t * (12 if open_ else 60)) * 0.5

def place(buf, sig, at, gain=1.0):
    i = int(at * SR)
    if i >= len(buf): return
    j = min(len(buf), i + len(sig))
    seg = sig[:j-i].copy(); f = min(len(seg), int(0.004 * SR))
    if f > 1: seg[-f:] *= np.linspace(1, 0, f)
    buf[i:j] += seg * gain

def stereo(l, r): return np.stack([l, r], axis=1)

def finish(mix, name):
    mix = np.stack([fft_lowpass(mix[:,0], 15000, 3000), fft_lowpass(mix[:,1], 15000, 3000)], axis=1)
    mix = mix / (np.max(np.abs(mix)) + 1e-9) * 0.98
    mix = np.tanh(mix * 1.4) / np.tanh(1.4)
    # мягкие фейды для бесшовного зацикливания
    n = int(0.02 * SR); mix[:n] *= np.linspace(0,1,n)[:,None]; mix[-n:] *= np.linspace(1,0,n)[:,None]
    data = (mix * 32767 * 0.95).astype(np.int16)
    with wave.open(name, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(data.tobytes())

# ---------------- 1. «Rise Up» — энергичный электро-поп, 124 BPM, ля минор ----------------
def track_rise():
    bpm = 124; beat = 60 / bpm; bars = 32; L = int(bars * 4 * beat * SR) + SR
    L_, R_ = np.zeros(L), np.zeros(L)
    prog = [(57, [57,60,64]), (53, [53,57,60]), (48, [48,52,55]), (55, [55,59,62])]  # Am F C G
    side = np.ones(L)
    for b in range(bars):
        sec = b // 8  # 0 вступление,1 куплет,2 припев,3 финал
        for q in range(4):
            t0 = (b*4+q)*beat
            if sec > 0 or q % 2 == 0:
                k = kick(); place(L_, k, t0, 0.9); place(R_, k, t0, 0.9)
                i = int(t0*SR); m = min(L, i+int(0.25*SR)); side[i:m] = np.minimum(side[i:m], np.linspace(0.25,1,m-i))
            if q in (1,3) and sec > 0:
                s = snare(); place(L_, s, t0, 0.45); place(R_, s, t0, 0.45)
            h = hat(open_=True); place(L_, h, t0+beat/2, 0.18 if sec else 0.1); place(R_, h, t0+beat/2, 0.22 if sec else 0.12)
            if sec >= 2:
                for e in (0.25, 0.75):
                    hh = hat(); place(L_, hh, t0+beat*e, 0.12); place(R_, hh, t0+beat*e, 0.09)
        root, ch = prog[b % 4]
        n = int(4*beat*SR); t = np.arange(n)/SR
        # бас — восьмые
        for e in range(8):
            nn = int(beat/2*SR*0.9); tt = np.arange(nn)/SR
            bs = (np.sin(2*np.pi*note_hz(root-24)*tt) + 0.3*saw(note_hz(root-24), tt))*env_adsr(nn,0.005,0.05,0.7,0.05)
            place(L_, bs, b*4*beat + e*beat/2, 0.35 if sec else 0.2); place(R_, bs, b*4*beat + e*beat/2, 0.35 if sec else 0.2)
        # аккорды-«пады» с пампингом
        pad = sum(saw(note_hz(m), t, 0.004) for m in ch) / 3
        pad = fft_lowpass(pad, 3200 if sec >= 2 else 1500, 800) * env_adsr(n, 0.02, 0.2, 0.8, 0.12)
        place(L_, pad, b*4*beat, 0.30); place(R_, np.roll(pad, 300), b*4*beat, 0.30)
        # мелодия-арпеджио в припеве и финале
        if sec >= 2:
            pattern = [ch[0]+12, ch[2]+12, ch[1]+12, ch[2]+12, ch[0]+24, ch[2]+12, ch[1]+12, ch[2]+12]
            for e, m in enumerate(pattern*2):
                nn = int(beat/4*SR); tt = np.arange(nn)/SR
                pl = (tri(note_hz(m), tt) + 0.4*np.sin(2*np.pi*note_hz(m)*2*tt)) * np.exp(-tt*14)
                pan = 0.5 + 0.35*np.sin(e)
                place(L_, pl, b*4*beat + e*beat/4, 0.16*(1-pan)*2); place(R_, pl, b*4*beat + e*beat/4, 0.16*pan*2)
    # пампинг применяем ко всему, кроме бочки (упрощённо — ко всему, бочка уже громкая)
    mix = stereo(L_*side + 0.0, R_*side)
    return mix[: int(bars*4*beat*SR)]

# ---------------- 2. «Lo-Fi Workshop» — спокойный лоу-фай, 84 BPM ----------------
def track_lofi():
    bpm = 84; beat = 60 / bpm; bars = 24; L = int(bars*4*beat*SR) + SR
    L_, R_ = np.zeros(L), np.zeros(L)
    chords = [[53,57,60,64], [52,55,59,62], [50,53,57,60], [48,52,55,59]]  # Fmaj7 Em7 Dm7 Cmaj7
    swing = 0.12
    for b in range(bars):
        for q in range(4):
            t0 = (b*4+q)*beat
            if q in (0, 2) or (q == 3 and b % 2):
                k = lp_fast(kick(punch=0.9), 900); place(L_, k, t0 + (beat*0.5 if q == 3 else 0), 0.8); place(R_, k, t0 + (beat*0.5 if q == 3 else 0), 0.8)
            if q in (1, 3):
                s = snare(dark=True); place(L_, s, t0, 0.35); place(R_, s, t0+0.003, 0.35)
            for e, off in enumerate((0, 0.5 + swing)):
                h = lp_fast(hat(), 9000); place(L_, h, t0 + off*beat, 0.10 if e == 0 else 0.07); place(R_, h, t0 + off*beat, 0.08)
        ch = chords[b % 4]; n = int(4*beat*SR)
        for i, m in enumerate(ch):
            ep = epiano(note_hz(m), n)
            place(L_, ep, b*4*beat + i*0.012, 0.22); place(R_, ep, b*4*beat + i*0.016, 0.22)
        nn = int(2*beat*SR); tt = np.arange(nn)/SR
        bs = np.sin(2*np.pi*note_hz(ch[0]-24)*tt)*env_adsr(nn, 0.01, 0.3, 0.6, 0.2)
        place(L_, bs, b*4*beat, 0.4); place(R_, bs, b*4*beat, 0.4)
        place(L_, bs, b*4*beat + 2.5*beat, 0.3); place(R_, bs, b*4*beat + 2.5*beat, 0.3)
        if b >= 8 and b % 2 == 0:  # простая мелодия
            mel = [ch[3]+12, ch[2]+12, ch[1]+12, ch[2]+12]
            for e, m in enumerate(mel):
                ep = epiano(note_hz(m), int(beat*SR*1.5))
                place(L_, ep, b*4*beat + e*beat, 0.12); place(R_, ep, b*4*beat + e*beat + 0.01, 0.14)
    crackle = (rng.random(L) > 0.9993) * rng.standard_normal(L) * 0.25 + lp_fast(rng.standard_normal(L), 3000)*0.006
    L_ += crackle; R_ += np.roll(crackle, 777)
    L_, R_ = fft_lowpass(L_, 6500), fft_lowpass(R_, 6500)
    mix = stereo(L_, R_)
    return mix[: int(bars*4*beat*SR)]

# ---------------- 3. «Horizon» — кинематографичный, 100 BPM, ре минор ----------------
def track_horizon():
    bpm = 100; beat = 60 / bpm; bars = 26; L = int(bars*4*beat*SR) + SR
    L_, R_ = np.zeros(L), np.zeros(L)
    prog = [[50,53,57], [46,50,53], [48,52,55], [45,49,52]]  # Dm Bb C A
    for b in range(bars):
        ch = prog[b % 4]; n = int(6*beat*SR); t = np.arange(n)/SR
        intensity = min(1.0, 0.35 + b / 16)
        pad = sum(np.sin(2*np.pi*note_hz(m)*t) + 0.5*np.sin(2*np.pi*note_hz(m+12)*t*1.002) for m in ch) / 4
        pad *= env_adsr(n, 0.6, 0.4, 0.9, 1.2)
        place(L_, pad, b*4*beat, 0.25*intensity); place(R_, np.roll(pad, 600), b*4*beat, 0.25*intensity)
        # «фортепианные» арпеджио шестнадцатыми
        arp = [ch[0]+12, ch[1]+12, ch[2]+12, ch[1]+24]
        for e in range(16):
            m = arp[e % 4]; nn = int(beat*SR); tt = np.arange(nn)/SR
            pn = (np.sin(2*np.pi*note_hz(m)*tt) + 0.3*np.sin(2*np.pi*note_hz(m)*3*tt)) * np.exp(-tt*5)
            pan = (e % 4) / 3
            place(L_, pn, b*4*beat + e*beat/4, 0.12*(1.2-pan)); place(R_, pn, b*4*beat + e*beat/4, 0.12*(0.2+pan))
        # барабаны вступают постепенно
        if b >= 6:
            for q in range(4):
                t0 = (b*4+q)*beat
                if q in (0, 2):
                    k = lp_fast(kick(punch=1.2), 600); place(L_, k, t0, 0.8*intensity); place(R_, k, t0, 0.8*intensity)
                if q == 3 and b % 2 == 1 and b >= 10:
                    for r in range(3):
                        tm = lp_fast(kick(int(0.35*SR)), 400); place(L_, tm, t0 + r*beat/3, 0.35); place(R_, tm, t0 + r*beat/3, 0.45)
        nn = int(5.5*beat*SR); tt = np.arange(nn)/SR
        bs = np.sin(2*np.pi*note_hz(ch[0]-24)*tt) * env_adsr(nn, 0.2, 0.5, 0.8, 0.9)
        place(L_, bs, b*4*beat, 0.35*intensity); place(R_, bs, b*4*beat, 0.35*intensity)
    mix = stereo(L_, R_)
    # простая «реверберация» — несколько затухающих задержек
    out = mix.copy()
    for d, g in ((0.031, 0.35), (0.067, 0.25), (0.113, 0.18), (0.171, 0.12)):
        k = int(d*SR); out[k:] += mix[:-k][:, ::-1] * g
    return out[: int(bars*4*beat*SR)]

for fn, name in ((track_rise, "rise_up"), (track_lofi, "lofi_workshop"), (track_horizon, "horizon")):
    finish(fn(), f"{name}.wav"); print(name, "ok")
