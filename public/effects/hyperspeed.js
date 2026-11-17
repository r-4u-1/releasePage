'use strict';
// HYPERSPEED INTRO — goes with hyperspeed.css
// Stars rush out from the centre: speeds up (accel), holds, flashes red, slows down (decel),
// then the overlay fades out, is removed, and the "intro-done" event fires.
//
// Needs this in index.html, first thing in <body>:
//   <div id="intro" aria-hidden="true"><canvas id="introCanvas"></canvas></div>
// To turn the effect off, remove that, this script and hyperspeed.css.

(function hyperspeedIntro() {
  const overlay = document.getElementById('intro');
  if (!overlay) return;

  // Ends the intro: removes the overlay and tells the other effects.
  function finish() {
    overlay.remove();
    window.dispatchEvent(new Event('intro-done'));
  }

  // People who asked their system for less motion skip the intro.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish();
    return;
  }

  const canvas = document.getElementById('introCanvas');
  const ctx = canvas.getContext('2d');

  const STAR_COUNT = 380;
  const MAX_SPEED = 38;
  const ACCEL_RATE = 1.062;          // speed is multiplied by this every frame while speeding up
  const ACCEL_MS = 1400, HOLD_MS = 300, DECEL_MS = 420, FADE_MS = 750;
  const COLORS = ['#ffffff', '#ffffff', '#ffcccc', '#FF4444', '#CC0011', '#FF1A2E', '#FF6633', '#AA0008'];

  let width = 0, height = 0, centerX = 0, centerY = 0;
  let speed = 0.8;
  let phase = 'accel'; // 'accel' → 'hold' → 'decel'
  let flashAlpha = 0;
  let flashed = false;
  let startTime = 0;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    centerX = width / 2;
    centerY = height / 2;
  }

  const random = (min, max) => min + Math.random() * (max - min);

  // A star moving straight out from the centre. New stars start near the centre.
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

  function moveStar(star) {
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

  function frame(now) {
    const elapsed = now - startTime;
    if (phase === 'accel' && elapsed >= ACCEL_MS) phase = 'hold';
    if (phase === 'hold' && elapsed >= ACCEL_MS + HOLD_MS) {
      phase = 'decel';
      if (!flashed) { flashed = true; flashAlpha = 0.55; }
    }
    if (phase === 'decel' && elapsed >= ACCEL_MS + HOLD_MS + DECEL_MS) {
      overlay.classList.add('fading');
      setTimeout(finish, FADE_MS);
      window.removeEventListener('resize', resize);
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
    requestAnimationFrame(frame);
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  startTime = performance.now();
  requestAnimationFrame(frame);
  window.addEventListener('resize', resize);
})();
