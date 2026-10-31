'use strict';

(function hyperspeedIntro() {
  const overlay = document.getElementById('intro');
  const canvas = document.getElementById('introCanvas');
  const ctx = canvas.getContext('2d');

  const STAR_COUNT = 380;
  const MAX_SPEED = 38;
  const ACCEL_RATE = 1.062;
  const ACCEL_MS = 1400, HOLD_MS = 300, DECEL_MS = 420, FADE_MS = 750;
  const COLORS = ['#ffffff', '#ffffff', '#ffcccc', '#FF4444', '#CC0011', '#FF1A2E', '#FF6633', '#AA0008'];

  let width, height, centerX, centerY;
  let speed = 0.8;
  let phase = 'accel';
  let flashAlpha = 0;
  let flashed = false;
  let startTime, frameId;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    centerX = width / 2;
    centerY = height / 2;
  }

  const random = (min, max) => min + Math.random() * (max - min);

  function makeStar(nearCenter) {
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

  function drawFlash() {
    if (flashAlpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = flashAlpha;
    ctx.fillStyle = '#CC0011';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  function moveStar(star) {
    star.prevX = star.x;
    star.prevY = star.y;
    if (phase === 'accel') star.speed = Math.min(star.speed * ACCEL_RATE, MAX_SPEED * 2.8);
    else if (phase === 'decel') star.speed = Math.max(star.speed * 0.88, 0.3);
    star.x += Math.cos(star.angle) * star.speed;
    star.y += Math.sin(star.angle) * star.speed;

    if (star.x < -60 || star.x > width + 60 || star.y < -60 || star.y > height + 60) {
      Object.assign(star, makeStar(true), { speed: speed * (phase === 'decel' ? 0.15 : 0.25) });
      return;
    }

    ctx.beginPath();
    ctx.strokeStyle = star.color;
    ctx.lineWidth = star.width * Math.max(1, star.speed / 12);
    ctx.globalAlpha = Math.min(0.95, star.speed / 9);
    ctx.moveTo(star.prevX, star.prevY);
    ctx.lineTo(star.x, star.y);
    ctx.stroke();
  }

  function frame(now) {
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

(function heading() {
  const RISE = { stagger: 52, duration: 580 };
  const SLIDE = { stagger: 16, duration: 460 };
  const PAUSE = 52;

  function animateLine(line, text) {
    const letters = [...text].map(char => {
      const span = document.createElement('span');
      span.className = 'char';
      span.textContent = char;
      return span;
    });
    line.append(...letters);
    const totalTime = ({ stagger, duration }) => (letters.length - 1) * stagger + duration;
    const play = (className, { stagger }) => letters.forEach((span, i) => {
      span.style.animationDelay = `${i * stagger}ms`;
      span.classList.add(className);
    });

    return new Promise(resolve => {
      play('rising', RISE);
      setTimeout(() => {
        letters.forEach(span => { span.style.animationDelay = ''; span.classList.remove('rising'); });
        void line.offsetWidth;
        play('sliding', SLIDE);
        setTimeout(() => {
          letters.forEach(span => { span.style.animationDelay = ''; span.classList.replace('sliding', 'done'); });
          resolve();
        }, totalTime(SLIDE));
      }, totalTime(RISE) + PAUSE);
    });
  }

  const show = (id, delay = 0) => setTimeout(() => document.getElementById(id).classList.add('visible'), delay);

  window.addEventListener('intro-done', () => {
    document.getElementById('textReveal').classList.add('revealed');
    show('eyebrow');
    show('sithFigure');
    setTimeout(async () => {
      await Promise.all([
        animateLine(document.getElementById('line1'), 'System Online'),
        animateLine(document.getElementById('line2'), 'Ready for input'),
      ]);
      show('heroDivider');
      show('heroBody', 130);
    }, 150);
  }, { once: true });
})();

(function sith() {
  const SABER_DELAY = 5200, SABER_GROW = 1800;
  const HILT_TOP = 88;
  const blades = [
    [document.getElementById('sx-so'), 70, 0.4],
    [document.getElementById('sx-sm'), 66, 0.75],
    [document.getElementById('sx-sc'), 62, 1],
  ];
  let firstFrame = null;

  function growSaber(now) {
    firstFrame ??= now;
    const elapsed = now - firstFrame;
    const progress = Math.max(0, Math.min(1, (elapsed - SABER_DELAY) / SABER_GROW));
    const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
    for (const [blade, fullHeight, opacity] of blades) {
      const height = fullHeight * eased;
      blade.setAttribute('height', height);
      blade.setAttribute('y', HILT_TOP - height);
      if (progress > 0) blade.style.opacity = opacity;
    }
    if (elapsed < SABER_DELAY + SABER_GROW + 300) requestAnimationFrame(growSaber);
  }
  requestAnimationFrame(growSaber);

  function flashBolt(bolt, minWait, maxWait) {
    setTimeout(() => {
      const flicker = [[0, '1'], [80, '0.25'], [140, '1'], [200, '0.6'], [260, '1'], [340, '0']];
      for (const [at, opacity] of flicker) setTimeout(() => { bolt.style.opacity = opacity; }, at);
      flashBolt(bolt, minWait, maxWait);
    }, minWait + Math.random() * (maxWait - minWait));
  }

  setTimeout(() => {
    flashBolt(document.getElementById('sx-b1'), 1200, 3500);
    setTimeout(() => flashBolt(document.getElementById('sx-b2'), 1800, 4200), 700);
  }, 7000);
})();
