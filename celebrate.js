/* Timely Fit — celebration effects (no dependencies).
 *   TimelyFX.burst(x, y)   small, tasteful confetti + petals from a point (a ticked set)
 *   TimelyFX.finale()      bigger multi-burst with sparks (finished session)
 *   TimelyFX.beep(kind)    short WebAudio tones ('end' = break over, 'tick' = soft click)
 * Everything draws on one fixed, click-through canvas that removes itself when idle.
 * With "reduce motion" turned on in the OS, no particles are drawn. */
(function () {
  'use strict';
  var COLORS = ['#ff6b6b', '#ffb020', '#ffd93d', '#6bd968', '#4cc9f0', '#7b6cf6', '#f78fb3'];
  var canvas = null, ctx = null, parts = [], raf = 0, last = 0;

  function reduced() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  function ensure() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:400';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    size();
    window.addEventListener('resize', size);
  }
  function size() {
    if (!canvas) return;
    var r = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * r); canvas.height = Math.round(innerHeight * r);
    ctx.setTransform(r, 0, 0, r, 0, 0);
  }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  function add(p) { parts.push(p); if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }

  /** shape: 'rect' confetti, 'petal' (round flower-like dot), 'spark' (thin bright line) */
  function make(x, y, angle, speed, shape, life) {
    return { x: x, y: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, g: shape === 'spark' ? 0.0004 : 0.0013,
      rot: rand(0, 6.28), vr: rand(-0.012, 0.012), w: shape === 'petal' ? rand(5, 8) : rand(5, 9), h: shape === 'petal' ? 0 : rand(3, 6),
      color: pick(COLORS), shape: shape, age: 0, life: life };
  }

  function frame(now) {
    var dt = Math.min(40, now - last); last = now;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter(function (p) { return p.age < p.life; });
    parts.forEach(function (p) {
      p.age += dt; p.vy += p.g * dt; p.vx *= 0.995; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      var a = Math.max(0, 1 - Math.pow(p.age / p.life, 2.2));
      ctx.globalAlpha = a; ctx.fillStyle = p.color; ctx.strokeStyle = p.color;
      if (p.shape === 'rect') { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); }
      else if (p.shape === 'petal') { ctx.beginPath(); ctx.arc(p.x, p.y, p.w / 2, 0, 6.283); ctx.fill(); }
      else { ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 90, p.y - p.vy * 90); ctx.stroke(); }
    });
    ctx.globalAlpha = 1;
    if (parts.length) raf = requestAnimationFrame(frame);
    else { raf = 0; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  /** A short, small burst: about 30 pieces, gone in about a second. */
  function burst(x, y) {
    if (reduced()) return;
    ensure();
    if (x == null) { x = innerWidth / 2; y = innerHeight * 0.55; }
    for (var i = 0; i < 26; i++) add(make(x, y, rand(-2.6, -0.55), rand(0.18, 0.5), i % 3 === 0 ? 'petal' : 'rect', rand(800, 1150)));
    for (var j = 0; j < 8; j++) add(make(x, y, rand(0, 6.28), rand(0.15, 0.32), 'spark', rand(350, 550)));
  }

  /** Session finished: confetti cannons from both bottom corners, then a shower with sparks. */
  function finale() {
    if (reduced()) return;
    ensure();
    var w = innerWidth, h = innerHeight;
    function cannon(x, dir) { for (var i = 0; i < 46; i++) add(make(x, h * 0.82, dir + rand(-0.35, 0.35), rand(0.35, 0.95), i % 4 === 0 ? 'petal' : 'rect', rand(1500, 2600))); }
    cannon(w * 0.08, -1.15); cannon(w * 0.92, -2.0);
    setTimeout(function () { cannon(w * 0.2, -1.3); cannon(w * 0.8, -1.85); }, 380);
    setTimeout(function () { for (var i = 0; i < 40; i++) add(make(rand(0, w), -10, rand(1.2, 1.9), rand(0.08, 0.2), i % 5 === 0 ? 'petal' : 'rect', rand(2200, 3200))); }, 700);
    setTimeout(function () { var cx = w / 2, cy = h * 0.3; for (var i = 0; i < 36; i++) add(make(cx, cy, (i / 36) * 6.283, rand(0.25, 0.5), 'spark', rand(500, 800))); }, 520);
  }

  var audio = null;
  function tone(freq, start, dur, vol) {
    var o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = freq; o.connect(g); g.connect(audio.destination);
    var t = audio.currentTime + start;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function beep(kind) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      if (kind === 'end') { tone(784, 0, 0.16, 0.18); tone(1047, 0.17, 0.26, 0.18); }
      else { tone(660, 0, 0.08, 0.08); }
    } catch (_) { /* audio is a bonus, never an error */ }
    try { if (navigator.vibrate) navigator.vibrate(kind === 'end' ? [60, 50, 90] : 12); } catch (_) {}
  }

  window.TimelyFX = { burst: burst, finale: finale, beep: beep };
})();
