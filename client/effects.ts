'use strict';
// The page's animations, in the order they play:
//   1. Hyperspeed intro — stars rush out from the centre, then the overlay fades away
//   2. Heading — letters rise in one by one, then slide into place; the text below fades in
//   3. Sith figure — transforms (CSS), grows a lightsaber, then flashes lightning forever

/* ═══════════════════════════════════════════════════════════════════════════
   1. HYPERSPEED INTRO
   Speeds up (accel), holds, flashes red, slows down (decel), then fades out
   and fires the "intro-done" event.
═══════════════════════════════════════════════════════════════════════════ */
(function hyperspeedIntro() {
  const overlay = document.getElementById('intro') as HTMLElement;
  const canvas = document.getElementById('introCanvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  const STAR_COUNT = 380;
  const MAX_SPEED = 38;
  const ACCEL_RATE = 1.062;          // speed is multiplied by this every frame while speeding up
  const ACCEL_MS = 1400, HOLD_MS = 300, DECEL_MS = 420, FADE_MS = 750;
  const COLORS = ['#ffffff', '#ffffff', '#ffcccc', '#FF4444', '#CC0011', '#FF1A2E', '#FF6633', '#AA0008'];

  interface Star {
    x: number; y: number;
    prevX: number; prevY: number;
    angle: number;
    speed: number;
    width: number;
    color: string;
  }

  let width = 0, height = 0, centerX = 0, centerY = 0;
  let speed = 0.8;
  let phase: 'accel' | 'hold' | 'decel' = 'accel';
  let flashAlpha = 0;
  let flashed = false;
  let startTime = 0, frameId = 0;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    centerX = width / 2;
    centerY = height / 2;
  }

  const random = (min: number, max: number) => min + Math.random() * (max - min);

  // A star moving straight out from the centre. New stars start near the centre.
  function makeStar(nearCenter: boolean): Star {
    const angle = Math.random() * Math.PI * 2;
    const distance = nearCenter ? Math.random() * 6 : Math.random() * Math.min(width, height) * 0.5;
    const x = centerX + Math.cos(angle) * distance;
    const y = centerY + Math.sin(angle) * distance;
    return {
      x, y,
      prevX: x, prevY: y,
      angle,
      speed: nearCenter ? speed * random(0.2, 0.8) : speed * random(0.5, 1.5),
      width: random(0.35, 1.45),
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
  }

  resize();
  const stars = Array.from({ length: STAR_COUNT }, (_, i) => makeStar(i < STAR_COUNT * 0.55));

  // A red glow in the centre that grows with the speed.
  function drawGlow() {
    const strength = Math.min(1, speed / MAX_SPEED);
    if (strength < 0.05) return;
    const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 20 + strength * 260);
    glow.addColorStop(0, `rgba(255,20,40,${strength * 0.65})`);
    glow.addColorStop(0.35, `rgba(192,0,20,${strength * 0.4})`);
    glow.addColorStop(0.7, `rgba(120,0,10,${strength * 0.2})`);
    glow.addColorStop(1, 'transparent');
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  // The red flash at top speed, fading a little every frame.
  function drawFlash() {
    if (flashAlpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = flashAlpha;
    ctx.fillStyle = '#CC0011';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  function moveStar(star: Star) {
    star.prevX = star.x;
    star.prevY = star.y;
    if (phase === 'accel') star.speed = Math.min(star.speed * ACCEL_RATE, MAX_SPEED * 2.8);
    else if (phase === 'decel') star.speed = Math.max(star.speed * 0.88, 0.3);
    star.x += Math.cos(star.angle) * star.speed;
    star.y += Math.sin(star.angle) * star.speed;

    // Off screen: start again near the centre.
    if (star.x < -60 || star.x > width + 60 || star.y < -60 || star.y > height + 60) {
      Object.assign(star, makeStar(true), { speed: speed * (phase === 'decel' ? 0.15 : 0.25) });
      return;
    }

    // A streak from where it was to where it is: faster = brighter and thicker.
    ctx.beginPath();
    ctx.strokeStyle = star.color;
    ctx.lineWidth = star.width * Math.max(1, star.speed / 12);
    ctx.globalAlpha = Math.min(0.95, star.speed / 9);
    ctx.moveTo(star.prevX, star.prevY);
    ctx.lineTo(star.x, star.y);
    ctx.stroke();
  }

  function frame(now: number) {
    const elapsed = now - startTime;
    if (phase === 'accel' && elapsed >= ACCEL_MS) phase = 'hold';
    if (phase === 'hold' && elapsed >= ACCEL_MS + HOLD_MS) {
      phase = 'decel';
      if (!flashed) { flashed = true; flashAlpha = 0.55; }
    }
    if (phase === 'decel' && elapsed >= ACCEL_MS + HOLD_MS + DECEL_MS) {
      overlay.classList.add('fading');
      setTimeout(() => {
        overlay.style.display = 'none';
        window.dispatchEvent(new Event('intro-done'));
      }, FADE_MS);
      cancelAnimationFrame(frameId);
      return;
    }

    if (phase === 'accel') speed = Math.min(speed * ACCEL_RATE, MAX_SPEED);
    else if (phase === 'decel') speed = Math.max(speed * 0.9, 0.5);
    flashAlpha = Math.max(0, flashAlpha - 0.04);

    // A see-through black fill leaves the trails behind the stars.
    ctx.fillStyle = phase === 'decel' ? 'rgba(0,0,0,0.48)' : 'rgba(0,0,0,0.30)';
    ctx.fillRect(0, 0, width, height);
    stars.forEach(moveStar);
    ctx.globalAlpha = 1;
    drawGlow();
    drawFlash();
    frameId = requestAnimationFrame(frame);
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  startTime = performance.now();
  frameId = requestAnimationFrame(frame);
  window.addEventListener('resize', resize);
})();

/* ═══════════════════════════════════════════════════════════════════════════
   2. HEADING — starts when the intro is done
═══════════════════════════════════════════════════════════════════════════ */
(function heading() {
  const RISE = { stagger: 52, duration: 580 };  // each letter starts 52 ms after the previous one
  const SLIDE = { stagger: 16, duration: 460 };
  const PAUSE = 52;                             // between rising and sliding

  // Splits the text into letters; they rise in one by one, then the line slides into place.
  function animateLine(line: HTMLElement, text: string) {
    const letters = [...text].map(char => {
      const span = document.createElement('span');
      span.className = 'char';
      span.textContent = char;
      return span;
    });
    line.append(...letters);
    type Timing = { stagger: number; duration: number };
    const totalTime = ({ stagger, duration }: Timing) => (letters.length - 1) * stagger + duration;
    const play = (className: string, { stagger }: Timing) => letters.forEach((span, i) => {
      span.style.animationDelay = `${i * stagger}ms`;
      span.classList.add(className);
    });

    return new Promise<void>(resolve => {
      play('rising', RISE);
      setTimeout(() => {
        letters.forEach(span => { span.style.animationDelay = ''; span.classList.remove('rising'); });
        void line.offsetWidth; // lets the slide animation start fresh
        play('sliding', SLIDE);
        setTimeout(() => {
          letters.forEach(span => { span.style.animationDelay = ''; span.classList.replace('sliding', 'done'); });
          resolve();
        }, totalTime(SLIDE));
      }, totalTime(RISE) + PAUSE);
    });
  }

  const show = (id: string, delay = 0) => setTimeout(() => document.getElementById(id)!.classList.add('visible'), delay);

  window.addEventListener('intro-done', () => {
    document.getElementById('textReveal')!.classList.add('revealed');
    show('eyebrow');
    show('sithFigure');
    setTimeout(async () => {
      await Promise.all([
        animateLine(document.getElementById('line1')!, 'System Online'),
        animateLine(document.getElementById('line2')!, 'Ready for input'),
      ]);
      show('heroDivider');
      show('heroBody', 130);
    }, 150);
  }, { once: true });
})();

/* ═══════════════════════════════════════════════════════════════════════════
   3. SITH FIGURE — the colour change is CSS; the saber and lightning are here
═══════════════════════════════════════════════════════════════════════════ */
(function sith() {
  const SABER_DELAY = 5200, SABER_GROW = 1800; // ms after page load
  const HILT_TOP = 88;                         // the blade grows up from here
  const rect = (id: string) => document.getElementById(id) as unknown as SVGRectElement;
  const blades: [SVGRectElement, number, number][] = [ // [element, full height, opacity]: glow, middle, core
    [rect('sx-so'), 70, 0.4],
    [rect('sx-sm'), 66, 0.75],
    [rect('sx-sc'), 62, 1],
  ];
  let firstFrame: number | null = null;

  function growSaber(now: number) {
    firstFrame ??= now;
    const elapsed = now - firstFrame;
    const progress = Math.max(0, Math.min(1, (elapsed - SABER_DELAY) / SABER_GROW));
    const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress; // ease in-out
    for (const [blade, fullHeight, opacity] of blades) {
      const height = fullHeight * eased;
      blade.setAttribute('height', String(height));
      blade.setAttribute('y', String(HILT_TOP - height));
      if (progress > 0) blade.style.opacity = String(opacity);
    }
    if (elapsed < SABER_DELAY + SABER_GROW + 300) requestAnimationFrame(growSaber);
  }
  requestAnimationFrame(growSaber);

  // A bolt flickers on and off, then flickers again after a random wait, forever.
  function flashBolt(bolt: SVGElement, minWait: number, maxWait: number) {
    setTimeout(() => {
      const flicker: [number, string][] = [[0, '1'], [80, '0.25'], [140, '1'], [200, '0.6'], [260, '1'], [340, '0']];
      for (const [at, opacity] of flicker) setTimeout(() => { bolt.style.opacity = opacity; }, at);
      flashBolt(bolt, minWait, maxWait);
    }, minWait + Math.random() * (maxWait - minWait));
  }

  setTimeout(() => {
    const bolt = (id: string) => document.getElementById(id) as unknown as SVGElement;
    flashBolt(bolt('sx-b1'), 1200, 3500);
    setTimeout(() => flashBolt(bolt('sx-b2'), 1800, 4200), 700);
  }, 7000);
})();
